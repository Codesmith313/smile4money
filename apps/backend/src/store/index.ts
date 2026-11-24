import { fileURLToPath } from 'node:url';
import { SqliteEvidenceStore } from './evidence-store.js';
import { SqliteMatchStore } from './sqlite-match-store.js';
import { SqliteSessionStore } from './session-store.js';

export const matchStore = new SqliteMatchStore();

export const evidenceStore = new SqliteEvidenceStore(process.env.ORACLE_EVIDENCE_DB ?? fileURLToPath(new URL('../../data/oracle-evidence.db', import.meta.url)));

export const sessionStore = new SqliteSessionStore(process.env.ORACLE_SESSION_DB ?? fileURLToPath(new URL('../../data/oracle-sessions.db', import.meta.url)));

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
  await sessionStore.initialize();
}

export async function closeMatchStore(): Promise<void> {
  await matchStore.close();
  await sessionStore.close();
}