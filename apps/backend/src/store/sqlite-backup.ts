/**
 * Backup, verification and restore for the oracle's SQLite databases (#104).
 *
 * The oracle keeps its durable state in SQLite files: pending result
 * submissions in `oracle-queue.db` (tables `oracle_dlq` and the versioned
 * dead-letter queue table `dlq_entries`) and match records in
 * `match-store.db`. Recovery objectives, schedule and the restore procedure
 * are in docs/oracle-db-recovery.md; this module is what that procedure runs,
 * and `tests/store/sqlite-backup-restore.test.ts` rehearses it.
 *
 * - `backupSqliteDatabase` takes a consistent online snapshot with
 *   `VACUUM INTO`, which is safe while the service is writing (WAL mode) and
 *   produces a single self-contained file with no `-wal`/`-shm` companions.
 *   The snapshot copies the whole database file, so persisted DLQ entries
 *   (`dlq_entries`, including its schema-version metadata) are always
 *   included; no table-specific handling is required.
 * - `verifySqliteBackup` runs `PRAGMA integrity_check` and counts rows per
 *   table, so a backup is known to be usable before it is needed. Table
 *   enumeration is generic, so `dlq_entries` (and any future versioned DLQ
 *   table) appears in the counts and its row count can be checked after a
 *   restore to confirm DLQ data survived.
 * - `restoreSqliteDatabase` verifies first, then swaps the file into place
 *   atomically. A corrupt backup never replaces a working database.
 * - `pruneBackups` enforces the retention window.
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import sqlite3 from 'sqlite3';

export interface BackupVerification {
  ok: boolean;
  /** `PRAGMA integrity_check` output; `['ok']` for a healthy file. */
  integrity: string[];
  /** Row count per user table. */
  tables: Record<string, number>;
}

function open(file: string, mode: number): Promise<sqlite3.Database> {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, mode, (err) => (err ? reject(err) : resolve(db)));
  });
}

function close(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())));
}

function all<T>(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<T[]> {
  return new Promise((resolve, reject) =>
    db.all(sql, params, (err: Error | null, rows: T[]) => (err ? reject(err) : resolve(rows))),
  );
}

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise((resolve, reject) =>
    db.run(sql, params, (err: Error | null) => (err ? reject(err) : resolve())),
  );
}

/**
 * Write a consistent snapshot of `sourcePath` to `backupPath`. Safe to run
 * against a live database. Refuses to overwrite an existing file.
 */
export async function backupSqliteDatabase(sourcePath: string, backupPath: string): Promise<void> {
  if (!fs.existsSync(sourcePath)) throw new Error(`database not found: ${sourcePath}`);
  if (fs.existsSync(backupPath)) throw new Error(`backup already exists: ${backupPath}`);
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });

  // Read-write only so a WAL database without a `-shm` file can be opened;
  // VACUUM INTO never modifies the source.
  const db = await open(sourcePath, sqlite3.OPEN_READWRITE);
  try {
    await run(db, 'VACUUM INTO ?', [backupPath]);
  } finally {
    await close(db);
  }
}

/** Check a backup file is a healthy SQLite database and count its rows. */
export async function verifySqliteBackup(file: string): Promise<BackupVerification> {
  if (!fs.existsSync(file)) return { ok: false, integrity: ['file not found'], tables: {} };
  let db: sqlite3.Database;
  try {
    // Read-write for the same WAL reason as backupSqliteDatabase; nothing is written.
    db = await open(file, sqlite3.OPEN_READWRITE);
  } catch (err) {
    return { ok: false, integrity: [err instanceof Error ? err.message : String(err)], tables: {} };
  }
  try {
    const integrity = (await all<{ integrity_check: string }>(db, 'PRAGMA integrity_check')).map(
      (row) => row.integrity_check,
    );
    const names = await all<{ name: string }>(
      db,
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    );
    const tables: Record<string, number> = {};
    for (const { name } of names) {
      const [row] = await all<{ n: number }>(
        db,
        `SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`,
      );
      tables[name] = row.n;
    }
    return { ok: integrity.length === 1 && integrity[0] === 'ok', integrity, tables };
  } catch (err) {
    return { ok: false, integrity: [err instanceof Error ? err.message : String(err)], tables: {} };
  } finally {
    await close(db).catch(() => {});
  }
}

/**
 * Replace `targetPath` with `backupPath`. The service using the database
 * must be stopped first. The backup is verified before anything is touched,
 * copied next to the target and renamed over it, and the target's stale
 * `-wal`/`-shm` files are removed so SQLite cannot replay them onto the
 * restored data.
 */
export async function restoreSqliteDatabase(
  backupPath: string,
  targetPath: string,
): Promise<BackupVerification> {
  const verification = await verifySqliteBackup(backupPath);
  if (!verification.ok) {
    throw new Error(
      `refusing to restore an unhealthy backup (${verification.integrity.join('; ')})`,
    );
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const staging = `${targetPath}.restoring`;
  fs.copyFileSync(backupPath, staging);
  for (const suffix of ['-wal', '-shm']) fs.rmSync(`${targetPath}${suffix}`, { force: true });
  fs.renameSync(staging, targetPath);
  return verification;
}

export interface RestoreRehearsal {
  ok: boolean;
  /** Verification of the backup taken from the source database. */
  backup: BackupVerification;
  /** Verification of the database after restoring the backup into a temp file. */
  restored: BackupVerification;
  /** Human-readable failure reason when `ok` is false. */
  error?: string;
}

/**
 * Rehearse the full recovery procedure against `sourcePath` without touching
 * it: take a backup, verify it, restore it into a temporary file, and run
 * `PRAGMA integrity_check` on the restored copy. Everything is written under
 * a temporary directory that is removed afterwards. Used by the quarterly
 * recovery drill and by `tests/store/sqlite-backup-restore.test.ts`.
 */
export async function verifyRestore(sourcePath: string): Promise<RestoreRehearsal> {
  const empty: BackupVerification = { ok: false, integrity: ['not run'], tables: {} };
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-restore-drill-'));
  const backupPath = path.join(workDir, backupFileName(sourcePath));
  const restoredPath = path.join(workDir, `restored-${path.basename(sourcePath)}`);
  try {
    await backupSqliteDatabase(sourcePath, backupPath);
    const backup = await verifySqliteBackup(backupPath);
    if (!backup.ok) {
      return { ok: false, backup, restored: empty, error: 'backup failed verification' };
    }
    const restored = await restoreSqliteDatabase(backupPath, restoredPath);
    if (!restored.ok) {
      return { ok: false, backup, restored, error: 'restored database failed verification' };
    }
    return { ok: true, backup, restored };
  } catch (err) {
    return {
      ok: false,
      backup: empty,
      restored: empty,
      error: err instanceof Error ? err.message : String(err),
    };
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/** File name for a backup taken at `at`, e.g. `oracle-queue.2026-10-22T14-00-00Z.db`. */
export function backupFileName(databasePath: string, at: Date = new Date()): string {
  const base = path.basename(databasePath, path.extname(databasePath));
  const stamp = at
    .toISOString()
    .replace(/\.\d{3}Z$/, 'Z')
    .replace(/:/g, '-');
  return `${base}.${stamp}.db`;
}

/**
 * Delete backups of `databasePath` in `dir` older than `retentionMs`,
 * always keeping the newest `keepAtLeast` regardless of age. Returns the
 * deleted file names.
 */
export function pruneBackups(
  dir: string,
  databasePath: string,
  retentionMs: number,
  now: number = Date.now(),
  keepAtLeast = 1,
): string[] {
  if (!fs.existsSync(dir)) return [];
  const base = path.basename(databasePath, path.extname(databasePath));
  const pattern = new RegExp(
    `^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.(\\d{4}-\\d{2}-\\d{2}T\\d{2}-\\d{2}-\\d{2}Z)\\.db$`,
  );
  const backups = fs
    .readdirSync(dir)
    .map((name) => {
      const match = pattern.exec(name);
      if (!match) return null;
      const iso = match[1].replace(/T(\d{2})-(\d{2})-(\d{2})Z$/, 'T$1:$2:$3Z');
      return { name, at: Date.parse(iso) };
    })
    .filter((b): b is { name: string; at: number } => b !== null && Number.isFinite(b.at))
    .sort((a, b) => b.at - a.at);

  const deleted: string[] = [];
  backups.forEach((backup, index) => {
    if (index < keepAtLeast || now - backup.at <= retentionMs) return;
    fs.rmSync(path.join(dir, backup.name), { force: true });
    deleted.push(backup.name);
  });
  return deleted;
}

/** Databases covered by the scheduled backup job. */
export const BACKUP_DATABASES = ['oracle-queue.db', 'match-store.db', 'oracle-evidence.db'];

export interface BackupConfig {
  /** Directory backups are written to. */
  dir: string;
  /** How often the job runs. */
  intervalMs: number;
  /** AES-256-GCM key material; backups are encrypted at rest when set. */
  encryptionKey?: string;
  /** Backups older than this are pruned. */
  retentionMs: number;
  /** Database file names (relative to the data dir) to back up. */
  databases: string[];
}

/** Read backup settings from the environment, falling back to defaults. */
export function backupConfigFromEnv(env: NodeJS.ProcessEnv = process.env): BackupConfig {
  const dir = env.BACKUP_DIR || path.join(process.cwd(), 'backups');
  const intervalMs = Number(env.BACKUP_INTERVAL_MS) || 6 * 60 * 60 * 1000;
  const retentionDays = Number(env.BACKUP_RETENTION_DAYS) || 7;
  return {
    dir,
    intervalMs,
    encryptionKey: env.BACKUP_ENCRYPTION_KEY || undefined,
    retentionMs: retentionDays * 24 * 60 * 60 * 1000,
    databases: BACKUP_DATABASES,
  };
}

function deriveKey(secret: string): Buffer {
  // Accept a 64-char hex key directly, otherwise derive one from the passphrase.
  if (/^[0-9a-fA-F]{64}$/.test(secret)) return Buffer.from(secret, 'hex');
  return crypto.createHash('sha256').update(secret).digest();
}

/**
 * Encrypt `file` in place with AES-256-GCM, writing `<file>.enc` and removing
 * the plaintext. Layout: 12-byte IV, 16-byte auth tag, then ciphertext.
 */
export function encryptBackupFile(file: string, secret: string): string {
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const plaintext = fs.readFileSync(file);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const out = `${file}.enc`;
  fs.writeFileSync(out, Buffer.concat([iv, cipher.getAuthTag(), ciphertext]));
  fs.rmSync(file, { force: true });
  return out;
}

/** Decrypt a file produced by `encryptBackupFile` to `outFile`. */
export function decryptBackupFile(file: string, secret: string, outFile: string): void {
  const key = deriveKey(secret);
  const data = fs.readFileSync(file);
  const iv = data.subarray(0, 12);
  const tag = data.subarray(12, 28);
  const ciphertext = data.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  fs.writeFileSync(outFile, Buffer.concat([decipher.update(ciphertext), decipher.final()]));
}

export interface BackupRunResult {
  database: string;
  backup?: string;
  ok: boolean;
  error?: string;
}

/**
 * Back up every configured database once: snapshot, verify, encrypt at rest,
 * then prune. Returns a per-database result.
 */
export async function runBackupCycle(
  config: BackupConfig,
  dataDir: string,
  now: Date = new Date(),
): Promise<BackupRunResult[]> {
  const results: BackupRunResult[] = [];
  for (const database of config.databases) {
    const source = path.join(dataDir, database);
    if (!fs.existsSync(source)) continue;
    const backupPath = path.join(config.dir, backupFileName(source, now));
    try {
      await backupSqliteDatabase(source, backupPath);
      const verification = await verifySqliteBackup(backupPath);
      if (!verification.ok) {
        throw new Error(`verification failed: ${verification.integrity.join('; ')}`);
      }
      const stored = config.encryptionKey
        ? encryptBackupFile(backupPath, config.encryptionKey)
        : backupPath;
      results.push({ database, backup: stored, ok: true });
    } catch (err) {
      fs.rmSync(backupPath, { force: true });
      results.push({
        database,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  pruneBackups(config.dir, path.join(dataDir, config.databases[0]), config.retentionMs, now.getTime());
  return results;
}

export interface ScheduledBackups {
  /** Stop the schedule and wait for any in-flight cycle to finish. */
  stop: () => Promise<void>;
}

/**
 * Start the periodic backup job. Runs one cycle immediately, then every
 * `config.intervalMs`. `log` receives structured events.
 */
export function startScheduledBackups(
  config: BackupConfig,
  dataDir: string,
  log: (event: string, details?: Record<string, unknown>) => void = () => {},
): ScheduledBackups {
  let running = false;
  let stopped = false;
  let timer: NodeJS.Timeout | undefined;
  let inFlight: Promise<void> = Promise.resolve();

  const cycle = async (): Promise<void> => {
    if (running || stopped) return;
    running = true;
    log('backup_started', { dir: config.dir, databases: config.databases });
    try {
      const results = await runBackupCycle(config, dataDir);
      const failed = results.filter((r) => !r.ok);
      if (failed.length > 0) {
        log('backup_failed', { failures: failed });
      } else {
        log('backup_completed', { backups: results.map((r) => r.backup) });
      }
    } catch (err) {
      log('backup_failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      running = false;
    }
  };

  const schedule = (): void => {
    if (stopped) return;
    inFlight = cycle();
    timer = setTimeout(schedule, config.intervalMs);
    if (typeof timer.unref === 'function') timer.unref();
  };
  schedule();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      await inFlight;
    },
  };
}
