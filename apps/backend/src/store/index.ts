import { fileURLToPath } from 'node:url';
import { SqliteEvidenceStore } from './evidence-store.js';
import { SqliteMatchStore } from './sqlite-match-store.js';
import { applySqliteMigrations, type SqliteMigration } from './migrations.js';

export const matchStore = new SqliteMatchStore();

export const evidenceStore = new SqliteEvidenceStore(process.env.ORACLE_EVIDENCE_DB ?? fileURLToPath(new URL('../../data/oracle-evidence.db', import.meta.url)));

/**
 * Registered, versioned schema migrations for the match store database.
 * Each migration must have a unique, monotonically increasing version.
 */
export const matchStoreMigrations: SqliteMigration[] = [
  // Add versioned migrations here as the schema evolves.
];

/** Initialize the match store's SQLite database. Call once at startup. */
export async function initializeMatchStore(): Promise<void> {
  await matchStore.initialize();

  try {
    const result = await applySqliteMigrations(matchStore, matchStoreMigrations);
    console.info(
      `[store] Applied ${result.applied.length} migration(s); current schema version: ${result.currentVersion}`,
    );
    if (result.applied.length > 0) {
      console.info(`[store] Applied migrations: ${result.applied.join(', ')}`);
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to apply match store migrations: ${message}`);
  }

  await evidenceStore.initialize();
}

export async function closeMatchStore(): Promise<void> {
  await matchStore.close();
}