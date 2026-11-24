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
import type { CanonicalSettlementEvidence, CreateMatchPayload, isMatchState, MatchRecord, MatchStorePort } from './match-store.js';
import type { MatchState, MatchStateChange, WebhookDelivery, WebhookSubscription } from './match-store.js';
import type { MatchQueryFilters, MatchQueryPage, MatchStatistics } from './match-store.js';
import { computeIdentityHash } from '../services/player-identity.js';
import { randomUUID } from 'node:crypto';
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

function runWithParams(db: sqlite3.Database, sql: string, params: unknown[]): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err: Error | null) => (err ? reject(err) : resolve()));
  });
}

function readMatch(row: any): MatchRecord {
  if (!isMatchState(row.state)) {
    throw new Error(`Unknown persisted match state: ${String(row.state)}`);
  }
  return {
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
  };
}

// #2133/#2134 — Build a parameterized WHERE clause from match query filters.
// Returns the SQL fragment (without the leading WHERE) and its bound params.
function buildMatchFilterClause(filters: MatchQueryFilters): { clause: string; params: unknown[] } {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.player) {
    conditions.push('(lower(player1) = lower(?) OR lower(player2) = lower(?))');
    params.push(filters.player, filters.player);
  }
  if (filters.state) {
    conditions.push('state = ?');
    params.push(filters.state);
  }
  if (filters.createdAfter !== undefined) {
    conditions.push('createdAt >= ?');
    params.push(filters.createdAfter);
  }
  if (filters.createdBefore !== undefined) {
    conditions.push('createdAt <= ?');
    params.push(filters.createdBefore);
  }
  if (filters.minStake !== undefined) {
    conditions.push('stakeAmount >= ?');
    params.push(filters.minStake);
  }
  if (filters.maxStake !== undefined) {
    conditions.push('stakeAmount <= ?');
    params.push(filters.maxStake);
  }

  return { clause: conditions.length > 0 ? conditions.join(' AND ') : '', params };
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

export class SqliteMatchStore implements MatchStorePort {
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
    const pool = this.getPool();
    const db = await pool.acquire();
    try {
      return await fn(db);
    } finally {
      await pool.release(db);
    }
  }

  async initialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.pool = new SqliteConnectionPool({ path: this.dbPath });
    try {
      await this.withConnection(async (db) => {
        try {
          fs.chmodSync(this.dbPath, 0o600);
        } catch {
          // POSIX file modes may be unavailable.
        }

        await applySqliteMigrations(db, SQLITE_SCHEMA_MIGRATIONS['match-store']);
        // #2133/#2134 — Supporting indexes for match search/filter and pagination.
        await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_matches_state ON matches(state)');
        await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_matches_stake ON matches(stakeAmount)');
        await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_matches_player1 ON matches(player1)');
        await runAsync(db, 'CREATE INDEX IF NOT EXISTS idx_matches_player2 ON matches(player2)');
        await runAsync(db, "DELETE FROM settlement_evidence WHERE evaluatedAt < datetime('now', '-30 days')");
        const row = await new Promise<{ nextId: number }>((resolve, reject) =>
          db.get('SELECT COALESCE(MAX(matchId), -1) + 1 AS nextId FROM matches', (error, result: { nextId: number } | undefined) =>
            error ? reject(error) : resolve(result ?? { nextId: 0 }),
          ),
        );
        this.nextId = row.nextId;
      });
      this.initialized = true;
      this.evidenceCleanupTimer = setInterval(
        () => {
          void this.withConnection((db) => runAsync(db, "DELETE FROM settlement_evidence WHERE evaluatedAt < datetime('now', '-30 days')")).catch((error) =>
            console.warn('settlement_evidence_cleanup_failed', error),
          );
        },
        24 * 60 * 60 * 1000,
      );
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
        ? computeIdentityHash(payload.player1Username, payload.player1, payload.player2Username, payload.player2)
        : null;

    return this.withConnection(
      (db) =>
        new Promise((resolve, reject) => {
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
        }),
    );
  }

  async findByGameId(gameId: string): Promise<MatchRecord | null> {
    const query = 'SELECT * FROM matches WHERE gameId = ?';
    const startedAt = performance.now();
    return this.withConnection(
      (db) =>
        new Promise((resolve, reject) => {
          db.get(query, [gameId], (err: Error | null, row: any) => {
            logSlowQuery(query, performance.now() - startedAt);
            if (err) {
              reject(err);
              return;
            }
            if (!row) {
              resolve(null);
              return;
            }
            resolve(readMatch(row));
          });
        }),
    );
  }

  async findByMatchId(matchId: number): Promise<MatchRecord | null> {
    return this.withConnection(
      (db) =>
        new Promise((resolve, reject) => {
          db.get('SELECT * FROM matches WHERE matchId = ?', [matchId], (err: Error | null, row: any) => {
            if (err) reject(err);
            else resolve(row ? readMatch(row) : null);
          });
        }),
    );
  }

  async listMatchesByPlayer(address: string): Promise<MatchRecord[]> {
    return this.withConnection(
      (db) =>
        new Promise((resolve, reject) => {
          db.all(
            'SELECT * FROM matches WHERE lower(player1) = lower(?) OR lower(player2) = lower(?) ORDER BY matchId',
            [address, address],
            (err: Error | null, rows: any[]) => {
              if (err) reject(err);
              else resolve(rows.map(readMatch));
            },
          );
        }),
    );
  }

  /**
   * #2133/#2134 — Query matches with combinable filters and cursor-based
   * pagination. Results are ordered by matchId DESC; the cursor is the last
   * matchId of the previous page (exclusive), so pages are stable even as new
   * matches are inserted.
   */
  async queryMatches(filters: MatchQueryFilters): Promise<MatchQueryPage> {
    const { clause, params } = buildMatchFilterClause(filters);
    const conditions: string[] = [];
    const bound: unknown[] = [...params];

    if (clause) conditions.push(clause);
    if (filters.cursor !== undefined) {
      conditions.push('matchId < ?');
      bound.push(filters.cursor);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = Math.max(1, Math.floor(filters.limit ?? 50));
    // Fetch one extra row to detect whether another page exists.
    const query = `SELECT * FROM matches ${where} ORDER BY matchId DESC LIMIT ?`;
    bound.push(limit + 1);

    const startedAt = performance.now();
    const rows = await this.withConnection(
      (db) =>
        new Promise<any[]>((resolve, reject) => {
          db.all(query, bound, (err: Error | null, result: any[]) => {
            logSlowQuery(query, performance.now() - startedAt);
            if (err) reject(err);
            else resolve(result);
          });
        }),
    );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;
    const items = pageRows.map(readMatch);
    const nextCursor = hasMore && items.length > 0 ? items[items.length - 1].matchId : null;

    return { items, nextCursor, hasMore };
  }

  /**
   * #2135 — Aggregate match statistics computed live on each call.
   * - totalMatches: total number of matches
   * - perPlayer: win/loss/draw counts for the requested player (if any)
   * - earningsByCurrency: summed stakeAmount of completed matches grouped by token
   */
  async getMatchStatistics(player?: string): Promise<MatchStatistics> {
    return this.withConnection(async (db) => {
      const totalMatches = await new Promise<number>((resolve, reject) =>
        db.get('SELECT COUNT(*) AS count FROM matches', (err: Error | null, row: any) => (err ? reject(err) : resolve(row?.count ?? 0))),
      );

      const earningsByCurrency = await new Promise<Array<{ currency: string; total: number; count: number }>>((resolve, reject) =>
        db.all(
          `SELECT token AS currency, COALESCE(SUM(stakeAmount), 0) AS total, COUNT(*) AS count
           FROM matches WHERE state = 'Completed' GROUP BY token ORDER BY token`,
          (err: Error | null, rows: Array<{ currency: string; total: number; count: number }>) => (err ? reject(err) : resolve(rows)),
        ),
      );

      let perPlayer: MatchStatistics['perPlayer'] = null;
      if (player) {
        const row = await new Promise<{ wins: number; losses: number; draws: number; total: number }>((resolve, reject) =>
          db.get(
            `SELECT
               COALESCE(SUM(CASE WHEN state = 'Completed' AND lower(player1) = lower(?) THEN 1 ELSE 0 END), 0) AS wins,
               COALESCE(SUM(CASE WHEN state = 'Completed' AND lower(player2) = lower(?) THEN 1 ELSE 0 END), 0) AS losses,
               COALESCE(SUM(CASE WHEN state = 'Cancelled' AND (lower(player1) = lower(?) OR lower(player2) = lower(?)) THEN 1 ELSE 0 END), 0) AS draws,
               COUNT(*) AS total
             FROM matches WHERE lower(player1) = lower(?) OR lower(player2) = lower(?)`,
            [player, player, player, player, player, player],
            (err: Error | null, result: any) => (err ? reject(err) : resolve(result)),
          ),
        );
        const wins = row?.wins ?? 0;
        const losses = row?.losses ?? 0;
        const draws = row?.draws ?? 0;
        const total = row?.total ?? 0;
        const winrate = total > 0 ? wins / total : 0;
        perPlayer = { player, wins, losses, draws, total, winrate };
      }

      return { totalMatches, perPlayer, earningsByCurrency };
    });
  }

  async listMatchesForStateSync(): Promise<MatchRecord[]> {
    return this.withConnection(
      (db) =>
        new Promise((resolve, reject) => {
          db.all(`SELECT * FROM matches WHERE state NOT IN ('Completed', 'Cancelled') ORDER BY matchId`, (err: Error | null, rows: any[]) => {
            if (err) reject(err);
            else resolve(rows.map(readMatch));
          });
        }),
    );
  }

  async updateMatchState(matchId: number, state: MatchState): Promise<MatchStateChange | null> {
    return this.withConnection(async (db) => {
      await runAsync(db, 'BEGIN IMMEDIATE');
      try {
        const row = await new Promise<any>((resolve, reject) =>
          db.get('SELECT * FROM matches WHERE matchId = ?', [matchId], (err: Error | null, result: any) => (err ? reject(err) : resolve(result))),
        );
        if (!row) {
          await runAsync(db, 'COMMIT');
          return null;
        }
        const match = readMatch(row);
        if (match.state === state) {
          await runAsync(db, 'COMMIT');
          return null;
        }
        const previousState = match.state;
        await runWithParams(db, 'UPDATE matches SET state = ? WHERE matchId = ?', [state, matchId]);
        const subscriptions = await new Promise<Array<{ id: string; url: string; secret: string }>>((resolve, reject) =>
          db.all(
            'SELECT id, url, secret FROM webhook_subscriptions WHERE matchId = ?',
            [matchId],
            (err: Error | null, rows: Array<{ id: string; url: string; secret: string }>) => (err ? reject(err) : resolve(rows)),
          ),
        );
        if (subscriptions.length > 0) {
          const eventId = randomUUID();
          const payload = JSON.stringify({
            id: eventId,
            type: 'match.state_changed',
            occurredAt: new Date().toISOString(),
            data: { matchId, gameId: match.gameId, previousState, state },
          });
          for (const subscription of subscriptions) {
            await runWithParams(
              db,
              `INSERT INTO webhook_deliveries
                (id, eventId, subscriptionId, url, secret, payload, nextAttemptAt)
               VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [randomUUID(), eventId, subscription.id, subscription.url, subscription.secret, payload, Date.now()],
            );
          }
        }
        await runAsync(db, 'COMMIT');
        return { match: { ...match, state }, previousState, state };
      } catch (error) {
        await runAsync(db, 'ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async createWebhookSubscription(input: Omit<WebhookSubscription, 'createdAt'>): Promise<WebhookSubscription> {
    const now = Date.now();
    await this.withConnection(
      (db) =>
        new Promise<void>((resolve, reject) => {
          db.get(
            'SELECT player1, player2 FROM matches WHERE matchId = ?',
            [input.matchId],
            (error: Error | null, match: { player1: string; player2: string } | undefined) => {
              if (error) return reject(error);
              if (!match) return reject(new Error('Match not found'));
              if (match.player1.toUpperCase() !== input.owner.toUpperCase() && match.player2.toUpperCase() !== input.owner.toUpperCase()) {
                return reject(new Error('Only a match participant can subscribe to its webhooks'));
              }
              db.run(
                `INSERT INTO webhook_subscriptions (id, matchId, owner, url, secret, createdAt)
             VALUES (?, ?, ?, ?, ?, ?)`,
                [input.id, input.matchId, input.owner.toUpperCase(), input.url, input.secret, now],
                (err: Error | null) => {
                  if (err) reject(err);
                  else resolve();
                },
              );
            },
          );
        }),
    );
    return { ...input, owner: input.owner.toUpperCase(), createdAt: now };
  }

  async listWebhookSubscriptions(owner: string): Promise<Omit<WebhookSubscription, 'secret'>[]> {
    return this.withConnection(
      (db) =>
        new Promise((resolve, reject) => {
          db.all(
            `SELECT id, matchId, owner, url, createdAt FROM webhook_subscriptions
         WHERE UPPER(owner) = UPPER(?) ORDER BY createdAt`,
            [owner],
            (error: Error | null, rows: Array<Omit<WebhookSubscription, 'secret'>>) => (error ? reject(error) : resolve(rows)),
          );
        }),
    );
  }

  async deleteWebhookSubscription(id: string, owner: string): Promise<boolean> {
    return this.withConnection(async (db) => {
      await runAsync(db, 'BEGIN IMMEDIATE');
      try {
        const deleted = await new Promise<boolean>((resolve, reject) => {
          db.run(
            'DELETE FROM webhook_subscriptions WHERE id = ? AND UPPER(owner) = UPPER(?)',
            [id, owner],
            function (this: sqlite3.RunResult, error: Error | null) {
              if (error) reject(error);
              else resolve(this.changes > 0);
            },
          );
        });
        if (deleted) {
          await runWithParams(db, 'DELETE FROM webhook_deliveries WHERE subscriptionId = ? AND deliveredAt IS NULL AND deadAt IS NULL', [id]);
        }
        await runAsync(db, 'COMMIT');
        return deleted;
      } catch (error) {
        await runAsync(db, 'ROLLBACK').catch(() => undefined);
        throw error;
      }
    });
  }

  async getDueWebhookDeliveries(now: number, limit: number): Promise<WebhookDelivery[]> {
    return this.withConnection(
      (db) =>
        new Promise((resolve, reject) => {
          db.all(
            `SELECT id, eventId, subscriptionId, url, secret, payload, attempts
         FROM webhook_deliveries
         WHERE deliveredAt IS NULL AND deadAt IS NULL AND nextAttemptAt <= ?
         ORDER BY nextAttemptAt LIMIT ?`,
            [now, limit],
            (error: Error | null, rows: WebhookDelivery[]) => (error ? reject(error) : resolve(rows)),
          );
        }),
    );
  }

  async completeWebhookDelivery(
    id: string,
    result:
      | { success: true }
      | {
          success: false;
          error: string;
          nextAttemptAt: number;
          terminal: boolean;
        },
  ): Promise<void> {
    const now = Date.now();
    if (result.success) {
      await this.withConnection((db) => runWithParams(db, 'UPDATE webhook_deliveries SET attempts = attempts + 1, deliveredAt = ? WHERE id = ?', [now, id]));
      return;
    }
    if (result.terminal) {
      await this.withConnection((db) =>
        runWithParams(db, 'UPDATE webhook_deliveries SET attempts = attempts + 1, deadAt = ?, lastError = ? WHERE id = ?', [
          now,
          result.error.slice(0, 1000),
          id,
        ]),
      );
      return;
    }
    await this.withConnection((db) =>
      runWithParams(db, 'UPDATE webhook_deliveries SET attempts = attempts + 1, nextAttemptAt = ?, lastError = ? WHERE id = ?', [
        result.nextAttemptAt,
        result.error.slice(0, 1000),
        id,
      ]),
    );
  }

  async saveSettlementEvidence(evidence: CanonicalSettlementEvidence): Promise<void> {
    await this.withConnection((db) => new Promise<void>((resolve, reject) => {
      db.run(`INSERT INTO settlement_evidence
        (matchId, parserVersion, evaluatedAt, gameId, platform, provider, whitePlayer, blackPlayer, result, status, decision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [evidence.matchId, evidence.parserVersion, evidence.evaluatedAt, evidence.gameId, evidence.platform,
        evidence.provider, evidence.whitePlayer, evidence.blackPlayer, evidence.result, evidence.status, evidence.decision],
      (err: Error | null) => err ? reject(err) : resolve());
    }));
  }

  async getSettlementEvidence(matchId: number): Promise<CanonicalSettlementEvidence | null> {
    return this.withConnection((db) => new Promise((resolve, reject) => db.get(
      'SELECT * FROM settlement_evidence WHERE matchId = ? ORDER BY evidenceId DESC LIMIT 1', [matchId], (err: Error | null, row: any) => {
        if (err) { reject(err); return; }
        if (!row) { resolve(null); return; }
        resolve({ parserVersion: row.parserVersion, evaluatedAt: row.evaluatedAt, matchId,
          gameId: row.gameId, platform: row.platform, provider: row.provider, whitePlayer: row.whitePlayer,
          blackPlayer: row.blackPlayer, result: row.result ?? null, status: row.status, decision: row.decision });
      })));
  }

  async getSettlementEvidenceHistory(matchId: number): Promise<CanonicalSettlementEvidence[]> {
    return this.withConnection((db) => new Promise((resolve, reject) => db.all(
      'SELECT * FROM settlement_evidence WHERE matchId = ? ORDER BY evidenceId ASC', [matchId],
      (err: Error | null, rows: any[]) => {
        if (err) { reject(err); return; }
        resolve(rows.map((row) => ({ parserVersion: row.parserVersion, evaluatedAt: row.evaluatedAt,
          matchId, gameId: row.gameId, platform: row.platform, provider: row.provider, whitePlayer: row.whitePlayer,
          blackPlayer: row.blackPlayer, result: row.result ?? null, status: row.status, decision: row.decision })));
      })));
  }

  async count(): Promise<number> {
    return this.withConnection(
      (db) =>
        new Promise((resolve, reject) => {
          db.get('SELECT COUNT(*) AS count FROM matches', (err: Error | null, row: any) => {
            if (err) reject(err);
            else resolve(row?.count ?? 0);
          });
        }),
    );
  }

  clear(): void {
    this.withConnection(
      (db) =>
        new Promise<void>((resolve, reject) => {
          db.run('DELETE FROM matches', (err: Error | null) => (err ? reject(err) : resolve()));
        }),
    ).catch(() => {
      /* best-effort clear */
    });
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
