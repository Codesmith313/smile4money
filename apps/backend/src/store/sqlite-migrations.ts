import sqlite3 from 'sqlite3';

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
  return new Promise((resolve, reject) => db.run(sql, (error) => (error ? reject(error) : resolve())));
}
function getVersion(db: sqlite3.Database): Promise<number> {
  return new Promise((resolve, reject) =>
    db.get('SELECT MAX(version) AS version FROM schema_version', (error, row: any) =>
      error ? reject(error) : resolve(row?.version ?? 0),
    ),
  );
}

const CREATE_SCHEMA_VERSION_TABLE =
  'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)';

/** Returns the highest applied migration version, or 0 if none have been applied. */
export async function getCurrentSchemaVersion(db: sqlite3.Database): Promise<number> {
  await run(db, CREATE_SCHEMA_VERSION_TABLE);
  return getVersion(db);
}

/** Apply ordered schema changes one transaction at a time. A failed migration
 * rolls back both its DDL and version marker, so startup can safely retry. */
export async function applySqliteMigrations(db: sqlite3.Database, migrations: SqliteMigration[]): Promise<void> {
  await run(db, CREATE_SCHEMA_VERSION_TABLE);
  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const current = await getVersion(db);
  if (current > (ordered[ordered.length - 1]?.version ?? 0)) {
    throw new Error(`SQLite schema version ${current} is newer than this application supports`);
  }
  for (const migration of ordered) {
    if (migration.version <= current) continue;
    await run(db, 'BEGIN IMMEDIATE');
    try {
      for (const statement of migration.statements) await run(db, statement);
      await new Promise<void>((resolve, reject) =>
        db.run(
          'INSERT INTO schema_version(version, name, applied_at) VALUES (?, ?, ?)',
          [migration.version, migration.name, Date.now()],
          (error) => (error ? reject(error) : resolve()),
        ),
      );
      await run(db, 'COMMIT');
    } catch (error) {
      await run(db, 'ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}

/** Roll back applied migrations down to (but not including) `targetVersion`.
 * Each migration's `down` statements run in reverse order within a transaction
 * that also removes its `schema_version` marker, so a failure leaves the
 * database at the previous consistent version. */
export async function rollbackSqliteMigrations(
  db: sqlite3.Database,
  migrations: SqliteMigration[],
  targetVersion: number,
): Promise<void> {
  await run(db, CREATE_SCHEMA_VERSION_TABLE);
  const ordered = [...migrations].sort((a, b) => b.version - a.version);
  const current = await getVersion(db);
  if (targetVersion < 0) {
    throw new Error(`Invalid target schema version ${targetVersion}`);
  }
  if (targetVersion > current) {
    throw new Error(`Cannot roll back to schema version ${targetVersion}: current version is ${current}`);
  }
  for (const migration of ordered) {
    if (migration.version <= targetVersion || migration.version > current) continue;
    if (!migration.down || migration.down.length === 0) {
      throw new Error(`Migration ${migration.version} (${migration.name}) has no down statements to roll back`);
    }
    await run(db, 'BEGIN IMMEDIATE');
    try {
      for (const statement of [...migration.down].reverse()) await run(db, statement);
      await new Promise<void>((resolve, reject) =>
        db.run('DELETE FROM schema_version WHERE version = ?', [migration.version], (error) =>
          error ? reject(error) : resolve(),
        ),
      );
      await run(db, 'COMMIT');
    } catch (error) {
      await run(db, 'ROLLBACK').catch(() => undefined);
      throw error;
    }
  }
}
