import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../utils/logger';
import { applySqliteMigrations } from './migrations';
import { listDatabases } from './maintenance';

export interface IntegrityCheckResult {
  timestamp: number;
  database: string;
  ok: boolean;
  details: string;
}

export interface IntegrityStatus {
  database: string;
  timestamp: number;
  ok: boolean;
  details: string;
}

export interface StartIntegrityCheckJobOptions {
  /** Directory containing the database files to check. */
  dataDir?: string;
  /** Explicit list of database file paths to check (overrides dataDir listing). */
  databases?: string[];
  /** Directory where the maintenance database lives. Defaults to dataDir. */
  maintenanceDir?: string;
  /** Optional alert callback invoked on failure. */
  alert?: (result: IntegrityCheckResult) => void;
  /** Override interval in ms. Defaults to env DB_INTEGRITY_CHECK_INTERVAL_MS or 6h. */
  intervalMs?: number;
}

const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;
const MAINTENANCE_DB_NAME = 'db-maintenance.db';

function resolveIntervalMs(override?: number): number {
  let interval = override;
  if (interval === undefined) {
    const envValue = process.env.DB_INTEGRITY_CHECK_INTERVAL_MS;
    if (envValue !== undefined && envValue !== '') {
      const parsed = Number(envValue);
      if (Number.isFinite(parsed) && parsed > 0) {
        interval = parsed;
      }
    }
  }
  if (interval === undefined || !Number.isFinite(interval) || interval <= 0) {
    interval = DEFAULT_INTERVAL_MS;
  }
  return Math.max(interval, MIN_INTERVAL_MS);
}

function resolveDataDir(options: StartIntegrityCheckJobOptions): string {
  if (options.dataDir) {
    return options.dataDir;
  }
  return process.env.DATA_DIR || process.env.DB_DIR || join(process.cwd(), 'data');
}

function resolveMaintenanceDbPath(options: StartIntegrityCheckJobOptions): string {
  const dir = options.maintenanceDir || resolveDataDir(options);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return join(dir, MAINTENANCE_DB_NAME);
}

function openMaintenanceDb(dbPath: string): Database.Database {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  applySqliteMigrations(db, [
    {
      id: 'db_integrity_checks',
      up: (database: Database.Database) => {
        database.exec(`
          CREATE TABLE IF NOT EXISTS db_integrity_checks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            timestamp INTEGER NOT NULL,
            database TEXT NOT NULL,
            ok INTEGER NOT NULL,
            details TEXT NOT NULL
          );
          CREATE INDEX IF NOT EXISTS idx_db_integrity_checks_database_timestamp
            ON db_integrity_checks (database, timestamp DESC);
        `);
      },
    },
  ]);
  return db;
}

function recordResult(db: Database.Database, result: IntegrityCheckResult): void {
  const stmt = db.prepare(
    `INSERT INTO db_integrity_checks (timestamp, database, ok, details)
     VALUES (?, ?, ?, ?)`,
  );
  stmt.run(result.timestamp, result.database, result.ok ? 1 : 0, result.details);
}

/**
 * Runs SQLite PRAGMA integrity_check against a single database file.
 */
export function runIntegrityCheck(databasePath: string): IntegrityCheckResult {
  const timestamp = Date.now();
  let db: Database.Database | undefined;
  try {
    if (!existsSync(databasePath)) {
      return {
        timestamp,
        database: databasePath,
        ok: false,
        details: 'database file not found',
      };
    }
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const rows = db.pragma('integrity_check') as Array<{ integrity_check: string }>;
    const messages = rows.map((row) => row.integrity_check);
    const ok = messages.length === 1 && messages[0] === 'ok';
    return {
      timestamp,
      database: databasePath,
      ok,
      details: messages.join('; ') || 'no result',
    };
  } catch (error) {
    return {
      timestamp,
      database: databasePath,
      ok: false,
      details: error instanceof Error ? error.message : String(error),
    };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }
}

function resolveDatabases(options: StartIntegrityCheckJobOptions): string[] {
  if (options.databases && options.databases.length > 0) {
    return options.databases;
  }
  const dataDir = resolveDataDir(options);
  try {
    return listDatabases(dataDir);
  } catch (error) {
    logger.error('db_integrity_check_list_failed', {
      dataDir,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function performChecks(options: StartIntegrityCheckJobOptions): IntegrityCheckResult[] {
  const databases = resolveDatabases(options);
  const maintenanceDbPath = resolveMaintenanceDbPath(options);
  const results: IntegrityCheckResult[] = [];

  let maintenanceDb: Database.Database | undefined;
  try {
    maintenanceDb = openMaintenanceDb(maintenanceDbPath);
  } catch (error) {
    logger.error('db_integrity_check_maintenance_db_failed', {
      path: maintenanceDbPath,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    for (const databasePath of databases) {
      const result = runIntegrityCheck(databasePath);
      results.push(result);

      if (maintenanceDb) {
        try {
          recordResult(maintenanceDb, result);
        } catch (error) {
          logger.error('db_integrity_check_record_failed', {
            database: databasePath,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      if (result.ok) {
        logger.info('db_integrity_check_ok', {
          database: result.database,
          timestamp: result.timestamp,
        });
      } else {
        logger.error('db_integrity_check_failed', {
          database: result.database,
          timestamp: result.timestamp,
          details: result.details,
        });
        if (options.alert) {
          try {
            options.alert(result);
          } catch (error) {
            logger.error('db_integrity_check_alert_failed', {
              database: result.database,
              error: error instanceof Error ? error.message : String(error),
            });
          }
        }
      }
    }
  } finally {
    if (maintenanceDb) {
      try {
        maintenanceDb.close();
      } catch {
        // ignore close errors
      }
    }
  }

  return results;
}

/**
 * Runs integrity checks immediately for all configured databases.
 */
export function runIntegrityCheckNow(
  options: StartIntegrityCheckJobOptions = {},
): IntegrityCheckResult[] {
  return performChecks(options);
}

/**
 * Starts the periodic integrity check job. Returns a stop function.
 */
export function startIntegrityCheckJob(
  options: StartIntegrityCheckJobOptions = {},
): () => void {
  const intervalMs = resolveIntervalMs(options.intervalMs);

  const run = () => {
    try {
      performChecks(options);
    } catch (error) {
      logger.error('db_integrity_check_job_failed', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  // Run once shortly after startup, then on the interval.
  const initialTimer = setTimeout(run, 0);
  if (typeof initialTimer.unref === 'function') {
    initialTimer.unref();
  }

  const interval = setInterval(run, intervalMs);
  if (typeof interval.unref === 'function') {
    interval.unref();
  }

  logger.info('db_integrity_check_job_started', { intervalMs });

  return () => {
    clearTimeout(initialTimer);
    clearInterval(interval);
    logger.info('db_integrity_check_job_stopped');
  };
}

/**
 * Returns the most recent recorded integrity check result per database.
 */
export function getLatestIntegrityStatus(
  options: StartIntegrityCheckJobOptions = {},
): IntegrityStatus[] {
  const maintenanceDbPath = resolveMaintenanceDbPath(options);
  if (!existsSync(maintenanceDbPath)) {
    return [];
  }

  let db: Database.Database | undefined;
  try {
    db = openMaintenanceDb(maintenanceDbPath);
    const rows = db
      .prepare(
        `SELECT c.database, c.timestamp, c.ok, c.details
         FROM db_integrity_checks c
         INNER JOIN (
           SELECT database, MAX(timestamp) AS max_ts
           FROM db_integrity_checks
           GROUP BY database
         ) latest
         ON c.database = latest.database AND c.timestamp = latest.max_ts
         ORDER BY c.database ASC`,
      )
      .all() as Array<{
      database: string;
      timestamp: number;
      ok: number;
      details: string;
    }>;

    return rows.map((row) => ({
      database: row.database,
      timestamp: row.timestamp,
      ok: row.ok === 1,
      details: row.details,
    }));
  } catch (error) {
    logger.error('db_integrity_status_failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore close errors
      }
    }
  }
}