/**
 * Runtime maintenance wiring: storage capacity alarms (#105) and the live
 * database restore trigger (#108). Installed once by server.ts.
 *
 * Live restore is triggered from the host, never over HTTP: write
 * `{"backupPath": "/path/to/backup.db"}` to `restore-request.json` next to
 * the queue database, then send SIGUSR2 to the backend process. The result
 * is written to `restore-result.json` in the same directory. Only someone
 * with shell access to the host can do both. See docs/live-restore.md.
 */
import fs from 'fs';
import path from 'path';
import { getMaintainableQueueStore } from './queue.js';
import { performLiveRestore, defaultRestoreRequestPath } from './store/live-restore.js';
import type { DlqEntry } from './store/persistent-queue-store.js';
import { startStorageCapacityMonitor, type CapacityLogger } from './store/storage-capacity.js';
import { startQueueStallDetector, type QueueStallDetectorOptions } from './store/queue-stall.js';
import { startIntegrityCheckJob } from './store/integrity-check.js';

export interface MaintenanceOptions {
  logger: CapacityLogger;
  /** On-chain check used to drop restored entries that were already settled. */
  isSettled?: (entry: DlqEntry) => Promise<boolean>;
  /** Signal that triggers a restore. Default SIGUSR2. */
  signal?: NodeJS.Signals;
  /** Queue stall detection tuning. Defaults come from config/env.ts. */
  stall?: Partial<QueueStallDetectorOptions>;
  /** Retention period in days. Defaults to RETENTION_DAYS or 30. */
  retentionDays?: number;
  /** Archive job interval in ms. Defaults to ARCHIVE_INTERVAL_MS or 24h. */
  archiveIntervalMs?: number;
}

const DEFAULT_RETENTION_DAYS = 30;
const DEFAULT_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Resolve archival settings from options, falling back to env vars and defaults. */
export function resolveArchivalOptions(options: MaintenanceOptions): ArchivalOptions {
  return {
    retentionDays:
      options.retentionDays ?? envNumber('RETENTION_DAYS', DEFAULT_RETENTION_DAYS),
    intervalMs:
      options.archiveIntervalMs ?? envNumber('ARCHIVE_INTERVAL_MS', DEFAULT_ARCHIVE_INTERVAL_MS),
  };
}

/** Query archived records separately from live data. */
export { queryArchived };

/** All SQLite databases in the queue database's directory. */
export function listDatabases(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith('.db'))
      .sort()
      .map((name) => path.join(dir, name));
  } catch {
    return [];
  }
}

/**
 * Handle one restore request. Exported for tests; the signal handler calls it.
 * Returns the result object that is also written to `restore-result.json`.
 */
export async function handleRestoreRequest(
  options: MaintenanceOptions,
): Promise<Record<string, unknown>> {
  const store = getMaintainableQueueStore();
  const databasePath = store?.databasePath();
  if (!store || !databasePath) {
    return { ok: false, error: 'no file-backed queue store is active' };
  }
  const requestPath = defaultRestoreRequestPath(databasePath);
  const resultPath = path.join(path.dirname(databasePath), 'restore-result.json');
  let result: Record<string, unknown>;
  try {
    const request = JSON.parse(fs.readFileSync(requestPath, 'utf8')) as { backupPath?: unknown };
    if (typeof request.backupPath !== 'string' || request.backupPath === '') {
      throw new Error('restore-request.json must contain a "backupPath" string');
    }
    const report = await performLiveRestore({
      store,
      backupPath: request.backupPath,
      databasePath,
      isSettled: options.isSettled,
      log: (event, fields) => options.logger.info({ ...fields }, event),
    });
    result = { ok: true, ...report };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    options.logger.error(result, 'live_restore_failed');
  }
  fs.rmSync(requestPath, { force: true });
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

/** Start the capacity monitor, the archival job and register the restore signal. */
export function installMaintenance(options: MaintenanceOptions): () => void {
  const store = getMaintainableQueueStore();
  const databasePath = store?.databasePath();
  const databases = databasePath ? listDatabases(path.dirname(databasePath)) : [];
  const stopMonitor = databasePath
    ? startStorageCapacityMonitor(databases, options.logger)
    : () => {};
  const stopIntegrityCheck = databasePath
    ? startIntegrityCheckJob(databases, options.logger)
    : () => {};

  const stopStallDetector = startQueueStallDetector({
    logger: options.logger,
    ...options.stall,
  });
  const archival = resolveArchivalOptions(options);
  let archiving = false;
  const runArchiveJob = () => {
    if (archiving) {
      options.logger.warn({}, 'archival_already_running');
      return;
    }
    archiving = true;
    options.logger.info(
      { retentionDays: archival.retentionDays },
      'archival_started',
    );
    void runArchival({ ...archival, log: options.logger })
      .then((report) => {
        options.logger.info({ ...report }, 'archival_completed');
      })
      .catch((err) => {
        options.logger.error(
          { error: err instanceof Error ? err.message : String(err) },
          'archival_failed',
        );
      })
      .finally(() => {
        archiving = false;
      });
  };
  const archiveTimer = setInterval(runArchiveJob, archival.intervalMs);
  if (typeof archiveTimer.unref === 'function') archiveTimer.unref();

  const signal = options.signal ?? 'SIGUSR2';
  let running = false;
  const onSignal = () => {
    if (running) {
      options.logger.warn({}, 'live_restore_already_running');
      return;
    }
    running = true;
    void handleRestoreRequest(options).finally(() => {
      running = false;
    });
  };
  process.on(signal, onSignal);

  return () => {
    stopMonitor();
    stopStallDetector();
    stopIntegrityCheck();
    process.off(signal, onSignal);
  };
}
