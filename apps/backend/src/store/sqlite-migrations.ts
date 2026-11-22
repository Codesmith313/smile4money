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
