import sqlite3 from 'sqlite3';

export interface SqliteMigration {
  version: number;
  name: string;
  statements: string[];
}

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

/** Apply ordered schema changes one transaction at a time. A failed migration
 * rolls back both its DDL and version marker, so startup can safely retry. */
export async function applySqliteMigrations(db: sqlite3.Database, migrations: SqliteMigration[]): Promise<void> {
  await run(
    db,
    'CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)',
  );
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

/** Data retention migrations: archive tables mirror live tables so records
 * older than the configured retention period can be moved out of the live
 * tables (reducing database size) while remaining queryable separately. */
export const retentionMigrations: SqliteMigration[] = [
  {
    version: 100,
    name: 'create_archive_tables',
    statements: [
      // Archived oracle dead-letter queue entries.
      `CREATE TABLE IF NOT EXISTS archived_oracle_dlq (
        id INTEGER PRIMARY KEY,
        original_id INTEGER NOT NULL,
        payload TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL,
        archived_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_archived_oracle_dlq_created_at ON archived_oracle_dlq(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_archived_oracle_dlq_archived_at ON archived_oracle_dlq(archived_at)`,
      `CREATE INDEX IF NOT EXISTS idx_archived_oracle_dlq_original_id ON archived_oracle_dlq(original_id)`,

      // Archived matches.
      `CREATE TABLE IF NOT EXISTS archived_matches (
        id INTEGER PRIMARY KEY,
        original_id INTEGER NOT NULL,
        payload TEXT,
        status TEXT,
        created_at INTEGER NOT NULL,
        archived_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_archived_matches_created_at ON archived_matches(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_archived_matches_archived_at ON archived_matches(archived_at)`,
      `CREATE INDEX IF NOT EXISTS idx_archived_matches_original_id ON archived_matches(original_id)`,

      // Archived settlement evidence.
      `CREATE TABLE IF NOT EXISTS archived_settlement_evidence (
        id INTEGER PRIMARY KEY,
        original_id INTEGER NOT NULL,
        payload TEXT,
        settlement_id TEXT,
        created_at INTEGER NOT NULL,
        archived_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_archived_settlement_evidence_created_at ON archived_settlement_evidence(created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_archived_settlement_evidence_archived_at ON archived_settlement_evidence(archived_at)`,
      `CREATE INDEX IF NOT EXISTS idx_archived_settlement_evidence_original_id ON archived_settlement_evidence(original_id)`,

      // Log of archival runs/events for auditing.
      `CREATE TABLE IF NOT EXISTS archival_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        records_archived INTEGER NOT NULL,
        retention_days INTEGER NOT NULL,
        cutoff_at INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS idx_archival_events_table_name ON archival_events(table_name)`,
      `CREATE INDEX IF NOT EXISTS idx_archival_events_started_at ON archival_events(started_at)`,
    ],
  },
];