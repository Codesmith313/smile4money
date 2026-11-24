import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';

export interface SessionPrincipal {
  userId: string;
  [key: string]: unknown;
}

export interface Session {
  sessionId: string;
  principal: SessionPrincipal;
  createdAt: number;
  expiresAt: number;
}

interface SessionRow {
  session_id: string;
  principal: string;
  created_at: number;
  expires_at: number;
}

export class SqliteSessionStore {
  private db: Database.Database;

  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        session_id TEXT PRIMARY KEY,
        principal TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions (expires_at);
    `);
  }

  createSession(principal: SessionPrincipal, ttlMs: number): Session {
    const now = Date.now();
    const session: Session = {
      sessionId: randomUUID(),
      principal,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    this.db
      .prepare(
        `INSERT INTO sessions (session_id, principal, created_at, expires_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(
        session.sessionId,
        JSON.stringify(session.principal),
        session.createdAt,
        session.expiresAt,
      );
    return session;
  }

  getSession(sessionId: string): Session | null {
    const row = this.db
      .prepare(
        `SELECT session_id, principal, created_at, expires_at
         FROM sessions WHERE session_id = ?`,
      )
      .get(sessionId) as SessionRow | undefined;
    if (!row) {
      return null;
    }
    if (row.expires_at <= Date.now()) {
      this.revokeSession(sessionId);
      return null;
    }
    return {
      sessionId: row.session_id,
      principal: JSON.parse(row.principal) as SessionPrincipal,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
    };
  }

  revokeSession(sessionId: string): boolean {
    const result = this.db
      .prepare(`DELETE FROM sessions WHERE session_id = ?`)
      .run(sessionId);
    return result.changes > 0;
  }

  purgeExpired(): number {
    const result = this.db
      .prepare(`DELETE FROM sessions WHERE expires_at <= ?`)
      .run(Date.now());
    return result.changes;
  }

  close(): void {
    this.db.close();
  }
}

let sessionStoreInstance: SqliteSessionStore | null = null;

export function initializeSessionStore(filename: string): SqliteSessionStore {
  if (sessionStoreInstance) {
    return sessionStoreInstance;
  }
  sessionStoreInstance = new SqliteSessionStore(filename);
  return sessionStoreInstance;
}

export function getSessionStore(): SqliteSessionStore {
  if (!sessionStoreInstance) {
    throw new Error('Session store has not been initialized');
  }
  return sessionStoreInstance;
}

export function closeSessionStore(): void {
  if (sessionStoreInstance) {
    sessionStoreInstance.close();
    sessionStoreInstance = null;
  }
}

export const sessionStore = {
  createSession: (principal: SessionPrincipal, ttlMs: number): Session =>
    getSessionStore().createSession(principal, ttlMs),
  getSession: (sessionId: string): Session | null =>
    getSessionStore().getSession(sessionId),
  revokeSession: (sessionId: string): boolean =>
    getSessionStore().revokeSession(sessionId),
  purgeExpired: (): number => getSessionStore().purgeExpired(),
};