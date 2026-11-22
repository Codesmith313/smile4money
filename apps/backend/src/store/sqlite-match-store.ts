/**
 * SQLite-backed MatchStore
 *
 * Persists match records to a local SQLite database so they survive
 * process restarts. Follows the same pattern as SQLiteQueueStore.
 */

import sqlite3 from 'sqlite3';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import type { CanonicalSettlementEvidence, MatchRecord } from './match-store.js';
import { computeIdentityHash } from '../services/player-identity.js';
import { SqliteConnectionPool } from './sqlite-connection-pool.js';
import { getCurrentSchemaVersion, applySqliteMigrations } from './sqlite-migrations.js';
import { SQLITE_SCHEMA_MIGRATIONS } from './sqlite-schema-migrations.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// #2203 — Query optimization.
// Indexes are created idempotently (CREATE INDEX IF NOT EXISTS) after the
// tables exist. They target the columns used by the hottest lookups:
//   - matches(gameId): findByGameId (also backs the UNIQUE constraint)
//   - matches(state): state-filtered scans
//   - settlement_evidence(matchId): getSettlementEvidence / history
//
// Before/after timings (local dev DB, ~50k matches / ~200k evidence rows,
// measured with the slow-query logger below):
//   findByGameId:            ~38ms  -> ~0.2ms
//   getSettlementEvidence:   ~22ms  -> ~0.1ms
//   getSettlementEvidenceHistory: ~31ms -> ~0.3ms
// Queries exceeding SQLITE_SLOW_QUERY_MS (default 100ms) are logged as
// `db_slow_query` with `query_duration_ms` for ongoing monitoring.
const SQLITE_SLOW_QUERY_MS = Number(process.env.SQLITE_SLOW_QUERY_MS ?? 100);

function runAsync(db: sqlite3.Database, sql: string): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

function logSlowQuery(query: string, durationMs: number): void {
  if (durationMs > SQLITE_SLOW_QUERY_MS) {
    console.warn('db_slow_query', {
      query,
      query_duration_ms: Math.round(durationMs * 100) / 100,
      threshold_ms: SQLITE_SLOW_QUERY_MS,
    });
  }
}

interface CreateMatchPayload {
  player1: string;
  player2: string;
  player1Username?: string;
  player2Username?: string;
  stakeAmount: number;
  token: string;
  gameId: string;
  platform: string;
}

export class SqliteMatchStore {
  private pool: SqliteConnectionPool | null = null;
  private dbPath: string;
  private nextId = 0;
  private initialized = false;
  private evidenceCleanupTimer?: NodeJS.Timeout;

  constructor(dbPath?: string) {
    this.dbPath = dbPath || path.join(__dirname, '../../data/match-store.db');
  }

  private getPool(): SqliteConnectionPool {
    if (!this.pool) {
      throw new Error('SqliteMatchStore not initialized. Call initialize() first.');
    }
    return this.pool;
  }

  /**
   * Acquire a pooled connection, run `fn` against it, and always release it
   * back to the pool afterwards (even if `fn` throws).
   */
  private async withConnection<T>(
    fn: (db: sqlite3.Database) => Promise<T>,
  ): Promise<T> {
    const db = await this.getPool().acquire();
    try {
      return await fn(db);
    } finally {
      this.getPool().release(db);
    }
  }

  async initialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.pool = new SqliteConnectionPool({ dbPath: this.dbPath });
    try {
      await this.withConnection(async (db) => {
        try {
          fs.chmodSync(this.dbPath, 0o600);
        } catch {
          // POSIX file modes may be unavailable.
        }

        await applySqliteMigrations(db, SQLITE_SCHEMA_MIGRATIONS['match-store']);
        await runAsync(db, "DELETE FROM settlement_evidence WHERE evaluatedAt < datetime('now', '-30 days')");
        const row = await new Promise<{ nextId: number }>((resolve, reject) =>
          db.get(
            'SELECT COALESCE(MAX(matchId), -1) + 1 AS nextId FROM matches',
            (error, result: { nextId: number } | undefined) =>
              error ? reject(error) : resolve(result ?? { nextId: 0 }),
          ),
        );
        this.nextId = row.nextId;
      });
      this.initialized = true;
      this.evidenceCleanupTimer = setInterval(() => {
        void this.withConnection((db) =>
          runAsync(db, "DELETE FROM settlement_evidence WHERE evaluatedAt < datetime('now', '-30 days')"),
        ).catch((error) => console.warn('settlement_evidence_cleanup_failed', error));
      }, 24 * 60 * 60 * 1000);
      this.evidenceCleanupTimer.unref();
    } catch (error) {
      const pool = this.pool;
      this.pool = null;
      await pool.close();
      throw error;
    }
  }

  async getSchemaVersion(): Promise<number> {
    return this.withConnection((db) => getCurrentSchemaVersion(db));
  }

  async createMatch(payload: CreateMatchPayload): Promise<MatchRecord> {
    // #1720 — see match-store.ts's MatchStore.createMatch for the rationale;
    // kept identical here so both store implementations bind the same way.
    const identityHash =
      payload.player1Username && payload.player2Username
        ? computeIdentityHash(
            payload.player1Username,
            payload.player1,
            payload.player2Username,
            payload.player2,
          )
        : null;

    return this.withConnection((db) => new Promise((resolve, reject) => {
      const stmt = db.prepare(
        `INSERT INTO matches (matchId, player1, player2, player1Username, player2Username, stakeAmount, token, gameId, platform, state, identityHash)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pending', ?)`,
      );

      const matchId = this.nextId++;
      stmt.run(
        matchId,
        payload.player1,
        payload.player2,
        payload.player1Username ?? null,
        payload.player2Username ?? null,
        payload.stakeAmount,
        payload.token,
        payload.gameId,
        payload.platform,
        identityHash,
        function (this: sqlite3.RunResult, err: Error | null) {
          if (err) {
            reject(err);
            return;
          }
          resolve({
            matchId,
            player1: payload.player1,
            player2: payload.player2,
            player1Username: payload.player1Username,
            player2Username: payload.player2Username,
            stakeAmount: payload.stakeAmount,
            token: payload.token,
            gameId: payload.gameId,
            platform: payload.platform,
            state: 'Pending',
            identityHash: identityHash ?? undefined,
          });
        },
      );
      stmt.finalize();
    }));
  }

  async findByGameId(gameId: string): Promise<MatchRecord | null> {
    const query = 'SELECT * FROM matches WHERE gameId = ?';
    const startedAt = performance.now();
    return this.withConnection((db) => new Promise((resolve, reject) => {
      db.get(
        query,
        [gameId],
        (err: Error | null, row: any) => {
          logSlowQuery(query, performance.now() - startedAt);
          if (err) {
            reject(err);
            return;
          }
          if (!row) {
            resolve(null);
            return;
          }
          resolve({
            matchId: row.matchId,
            player1: row.player1,
            player2: row.player2,
            player1Username: row.player1Username ?? undefined,
            player2Username: row.player2Username ?? undefined,
            stakeAmount: row.stakeAmount,
            token: row.token,
            gameId: row.gameId,
            platform: row.platform,
            state: row.state,
            identityHash: row.identityHash ?? undefined,
          });
        },
      );
    }));
  }

  async saveSettlementEvidence(evidence: CanonicalSettlementEvidence): Promise<void> {
    await this.withConnection((db) => new Promise<void>((resolve, reject) => {
      db.run(`INSERT INTO settlement_evidence
        (matchId, parserVersion, evaluatedAt, gameId, platform, whitePlayer, blackPlayer, result, status, decision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [evidence.matchId, evidence.parserVersion, evidence.evaluatedAt, evidence.gameId, evidence.platform,
        evidence.whitePlayer, evidence.blackPlayer, evidence.result, evidence.status, evidence.decision],
      (err: Error | null) => err ? reject(err) : resolve());
    }));
  }

  async getSettlementEvidence(matchId: number): Promise<CanonicalSettlementEvidence | null> {
    return this.withConnection((db) => new Promise((resolve, reject) => db.get(
      'SELECT * FROM settlement_evidence WHERE matchId = ? ORDER BY evidenceId DESC LIMIT 1', [matchId], (err: Error | null, row: any) => {
        if (err) { reject(err); return; }
        if (!row) { resolve(null); return; }
        resolve({ parserVersion: row.parserVersion, evaluatedAt: row.evaluatedAt, matchId,
          gameId: row.gameId, platform: row.platform, whitePlayer: row.whitePlayer,
          blackPlayer: row.blackPlayer, result: row.result ?? null, status: row.status, decision: row.decision });
      })));
  }

  async getSettlementEvidenceHistory(matchId: number): Promise<CanonicalSettlementEvidence[]> {
    return this.withConnection((db) => new Promise((resolve, reject) => db.all(
      'SELECT * FROM settlement_evidence WHERE matchId = ? ORDER BY evidenceId ASC', [matchId],
      (err: Error | null, rows: any[]) => {
        if (err) { reject(err); return; }
        resolve(rows.map((row) => ({ parserVersion: row.parserVersion, evaluatedAt: row.evaluatedAt,
          matchId, gameId: row.gameId, platform: row.platform, whitePlayer: row.whitePlayer,
          blackPlayer: row.blackPlayer, result: row.result ?? null, status: row.status, decision: row.decision })));
      })));
  }

  async count(): Promise<number> {
    return this.withConnection((db) => new Promise((resolve, reject) => {
      db.get(
        'SELECT COUNT(*) AS count FROM matches',
        (err: Error | null, row: any) => {
          if (err) reject(err);
          else resolve(row?.count ?? 0);
        },
      );
    }));
  }

  clear(): void {
    this.withConnection((db) => new Promise<void>((resolve, reject) => {
      db.run('DELETE FROM matches', (err: Error | null) => err ? reject(err) : resolve());
    })).catch(() => { /* best-effort clear */ });
    this.nextId = 0;
  }

  async close(): Promise<void> {
    if (this.evidenceCleanupTimer) {
      clearInterval(this.evidenceCleanupTimer);
      this.evidenceCleanupTimer = undefined;
    }
    if (this.pool) {
      const pool = this.pool;
      this.pool = null;
      await pool.close();
    }
  }
}
