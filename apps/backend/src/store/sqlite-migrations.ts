import path from "node:path";
import { pathToFileURL } from "node:url";
import sqlite3 from "sqlite3";

export interface SqliteMigration {
  version: number;
  name: string;
  statements: string[];
  /** Statements that undo this migration, applied in reverse order on rollback. */
  down?: string[];
}

/** Durable dead-letter queue storage. Entries are persisted to disk so they
 * survive process restarts; the created_at index supports TTL eviction. */
export const createDlqEntriesMigration: SqliteMigration = {
  version: 1,
  name: 'create_dlq_entries',
  statements: [
    `CREATE TABLE IF NOT EXISTS dlq_entries (
      id TEXT PRIMARY KEY,
      payload TEXT NOT NULL,
      failure_reason TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      last_attempt_at INTEGER,
      trace_context TEXT
    )`,
    'CREATE INDEX IF NOT EXISTS idx_dlq_entries_created_at ON dlq_entries(created_at)',
  ],
  down: [
    'DROP INDEX IF EXISTS idx_dlq_entries_created_at',
    'DROP TABLE IF EXISTS dlq_entries',
  ],
};

/** Ordered list of all known migrations, applied in version order. */
export const sqliteMigrations: SqliteMigration[] = [createDlqEntriesMigration];

function run(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) =>
    db.run(sql, (error) => (error ? reject(error) : resolve())),
  );
}

function runWithParams(
  db: sqlite3.Database,
  sql: string,
  params: unknown[],
): Promise<void> {
  return new Promise((resolve, reject) =>
    db.run(sql, params, (error) => (error ? reject(error) : resolve())),
  );
}

const CREATE_SCHEMA_VERSION_TABLE =
  "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)";

function validateMigrations(migrations: SqliteMigration[]): SqliteMigration[] {
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  for (let index = 0; index < ordered.length; index += 1) {
    const migration = ordered[index];
    if (
      !Number.isSafeInteger(migration.version) ||
      migration.version !== index + 1
    ) {
      throw new Error(
        "SQLite migration versions must be unique, positive, and consecutive starting at 1",
      );
    }
    if (!migration.name.trim() || migration.statements.length === 0) {
      throw new Error(
        `SQLite migration ${migration.version} must have a name and at least one statement`,
      );
    }
  }
  return ordered;
}

async function getAppliedVersions(db: sqlite3.Database): Promise<number[]> {
  return new Promise((resolve, reject) =>
    db.all(
      "SELECT version FROM schema_version ORDER BY version ASC",
      (error, rows: Array<{ version: number }>) =>
        error ? reject(error) : resolve(rows.map((row) => row.version)),
    ),
  );
}

/** Returns the highest applied migration version, or 0 if none have been applied. */
export async function getCurrentSchemaVersion(
  db: sqlite3.Database,
): Promise<number> {
  await run(db, CREATE_SCHEMA_VERSION_TABLE);
  const versions = await getAppliedVersions(db);
  return versions[versions.length - 1] ?? 0;
}

/** Apply ordered schema changes one transaction at a time. A failed migration
 * rolls back both its DDL and version marker, so startup can safely retry. */
export async function applySqliteMigrations(
  db: sqlite3.Database,
  migrations: SqliteMigration[],
): Promise<{ currentVersion: number; appliedMigrations: string[] }> {
  await run(db, CREATE_SCHEMA_VERSION_TABLE);
  const ordered = validateMigrations(migrations);
  const versions = await getAppliedVersions(db);
  const current = versions[versions.length - 1] ?? 0;
  if (versions.some((version, index) => version !== index + 1)) {
    throw new Error("SQLite schema version history is not consecutive");
  }
  if (current > ordered.length) {
    throw new Error(
      `SQLite schema version ${current} is newer than this application supports`,
    );
  }
  const appliedMigrations: string[] = [];
  for (const migration of ordered) {
    if (migration.version <= current) continue;
    await run(db, "BEGIN IMMEDIATE");
    try {
      for (const statement of migration.statements) await run(db, statement);
      await runWithParams(
        db,
        "INSERT INTO schema_version(version, name, applied_at) VALUES (?, ?, ?)",
        [migration.version, migration.name, Date.now()],
      );
      await run(db, "COMMIT");
      appliedMigrations.push(migration.name);
    } catch (error) {
      await run(db, "ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
  return { currentVersion: ordered.length, appliedMigrations };
}

/** Roll back applied migrations down to (but not including) `targetVersion`.
 * Each migration's `down` statements run in reverse order within a transaction
 * that also removes its `schema_version` marker, so a failure leaves the
 * database at the previous consistent version. */
export async function rollbackSqliteMigrations(
  db: sqlite3.Database,
  migrations: SqliteMigration[],
  targetVersion: number,
): Promise<{ currentVersion: number; rolledBackMigrations: string[] }> {
  await run(db, CREATE_SCHEMA_VERSION_TABLE);
  const ordered = validateMigrations(migrations).reverse();
  const versions = await getAppliedVersions(db);
  const current = versions[versions.length - 1] ?? 0;
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0) {
    throw new Error(`Invalid target schema version ${targetVersion}`);
  }
  if (targetVersion > current) {
    throw new Error(
      `Cannot roll back to schema version ${targetVersion}: current version is ${current}`,
    );
  }
  if (versions.some((version, index) => version !== index + 1)) {
    throw new Error("SQLite schema version history is not consecutive");
  }
  if (current > ordered.length) {
    throw new Error(
      `SQLite schema version ${current} is newer than this application supports`,
    );
  }
  const rolledBackMigrations: string[] = [];
  for (const migration of ordered) {
    if (migration.version <= targetVersion || migration.version > current)
      continue;
    if (!migration.down || migration.down.length === 0) {
      throw new Error(
        `Migration ${migration.version} (${migration.name}) has no down statements to roll back`,
      );
    }
    await run(db, "BEGIN IMMEDIATE");
    try {
      for (const statement of [...migration.down].reverse())
        await run(db, statement);
      await runWithParams(db, "DELETE FROM schema_version WHERE version = ?", [
        migration.version,
      ]);
      await run(db, "COMMIT");
      rolledBackMigrations.push(migration.name);
    } catch (error) {
      await run(db, "ROLLBACK").catch(() => undefined);
      throw error;
    }
  }
  return { currentVersion: targetVersion, rolledBackMigrations };
}

/** Opens the SQLite database used by the store. */
export function openSqliteDatabase(filename: string): sqlite3.Database {
  return new sqlite3.Database(filename);
}

function closeDatabase(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) =>
    db.close((error) => (error ? reject(error) : resolve())),
  );
}

/** Apply all pending migrations on startup. Failures propagate so the process
 * does not continue running against a partially migrated schema. */
export async function migrateOnStartup(
  db: sqlite3.Database,
  migrations: SqliteMigration[] = sqliteMigrations,
): Promise<{ currentVersion: number; appliedMigrations: string[] }> {
  return applySqliteMigrations(db, migrations);
}

interface CliOptions {
  command: "migrate" | "rollback" | "status";
  database: string;
  targetVersion?: number;
}

function parseCliArgs(argv: string[]): CliOptions {
  const [command, ...rest] = argv;
  if (command !== "migrate" && command !== "rollback" && command !== "status") {
    throw new Error(
      'Usage: sqlite-migrations <migrate|rollback|status> --database <path> [--to <version>]',
    );
  }
  let database = process.env.SQLITE_DATABASE_PATH ?? "";
  let targetVersion: number | undefined;
  for (let index = 0; index < rest.length; index += 1) {
    const arg = rest[index];
    if (arg === "--database" || arg === "--db") {
      database = rest[index + 1] ?? "";
      index += 1;
    } else if (arg === "--to" || arg === "--target") {
      const raw = rest[index + 1];
      targetVersion = raw === undefined ? undefined : Number(raw);
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  if (!database) {
    throw new Error("A database path is required (--database <path>)");
  }
  if (command === "rollback") {
    if (targetVersion === undefined || !Number.isSafeInteger(targetVersion)) {
      throw new Error("Rollback requires a numeric target version (--to <version>)");
    }
  }
  return { command, database, targetVersion };
}

/** CLI entrypoint: `migrate`, `rollback --to <version>`, or `status`. */
export async function runMigrationCli(argv: string[]): Promise<void> {
  const options = parseCliArgs(argv);
  const db = openSqliteDatabase(options.database);
  try {
    if (options.command === "migrate") {
      const result = await applySqliteMigrations(db, sqliteMigrations);
      console.log(
        `Applied ${result.appliedMigrations.length} migration(s); current version ${result.currentVersion}`,
      );
    } else if (options.command === "rollback") {
      const result = await rollbackSqliteMigrations(
        db,
        sqliteMigrations,
        options.targetVersion as number,
      );
      console.log(
        `Rolled back ${result.rolledBackMigrations.length} migration(s); current version ${result.currentVersion}`,
      );
    } else {
      const version = await getCurrentSchemaVersion(db);
      console.log(`Current schema version: ${version}`);
    }
  } finally {
    await closeDatabase(db);
  }
}

const isDirectRun =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isDirectRun) {
  runMigrationCli(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
