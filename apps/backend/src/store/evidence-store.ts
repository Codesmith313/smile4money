import sqlite3 from 'sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { Evidence } from '../fetchers/result.js';
import type { MatchResult } from '../fetchers/lichess.js';
import { applySqliteMigrations } from './sqlite-migrations.js';
import { SQLITE_SCHEMA_MIGRATIONS } from './sqlite-schema-migrations.js';

export type OperatorDecision =
  | { action: 'accept'; result: Exclude<MatchResult, null> }
  | { action: 'reject' };

export interface Decision {
  id?: number;
  matchId: number;
  gameId: string;
  state: 'review_required' | 'verified' | 'in_progress' | 'retry_requested' | 'provider_changed';
  reason: string;
  provider?: Evidence['provider'];
  previousProvider?: Evidence['provider'];
  evidence?: Evidence;
  previousEvidence?: Evidence;
  recordedAt: string;
  operator?: string;
  /** SHA-256 hash of the serialized decision body, used for tamper detection. */
  hash?: string;
}
export interface EvidenceStore {
  history(gameId: string): Promise<Decision[]>;
  query(options?: { gameId?: string; startTime?: number; endTime?: number }): Promise<Decision[]>;
  append(decision: Decision): Promise<number>;
}

/** Compute the canonical SHA-256 hash of a decision body (excluding id and hash). */
export function computeDecisionHash(decision: Decision): string {
  const { id: _id, hash: _hash, ...body } = decision;
  return createHash('sha256').update(JSON.stringify(body)).digest('hex');
}

function verifyDecisionHash(decision: Decision, storedHash?: string): void {
  const expected = storedHash ?? decision.hash;
  if (!expected) return;
  const actual = computeDecisionHash(decision);
  if (actual !== expected) {
    console.error(
      `[evidence-store] Evidence hash mismatch for decision ${decision.id ?? 'unknown'} (game ${decision.gameId}): expected ${expected}, computed ${actual}`,
    );
  }
}

function validateDecision(decision: Decision): void {
  if (!decision.reason.trim()) {
    throw new Error('Decision reason is required');
  }
  if (
    !Number.isFinite(Date.parse(decision.recordedAt)) ||
    new Date(decision.recordedAt).toISOString() !== decision.recordedAt
  ) {
    throw new Error('A valid ISO 8601 timestamp is required for decisions');
  }
  if (decision.state === 'retry_requested' && !decision.operator?.trim()) {
    throw new Error('Operator identity is required for operator decisions');
  }
}

export class MemoryEvidenceStore implements EvidenceStore {
  private entries: Decision[] = [];
  async history(gameId: string): Promise<Decision[]> {
    return this.entries
      .filter((e) => e.gameId === gameId)
      .map((e) => {
        verifyDecisionHash(e);
        return structuredClone(e);
      });
  }
  async query(
    options: {
      gameId?: string;
      startTime?: number;
      endTime?: number;
    } = {},
  ): Promise<Decision[]> {
    return this.entries
      .filter((entry) => {
        const recordedAt = Date.parse(entry.recordedAt);
        return (
          (!options.gameId || entry.gameId === options.gameId) &&
          (options.startTime === undefined || recordedAt >= options.startTime) &&
          (options.endTime === undefined || recordedAt <= options.endTime)
        );
      })
      .map((entry) => {
        verifyDecisionHash(entry);
        return structuredClone(entry);
      });
  }
  async append(decision: Decision): Promise<number> {
    validateDecision(decision);
    const id = this.entries.length + 1;
    const stored = { ...decision, id };
    stored.hash = computeDecisionHash(stored);
    this.entries.push(structuredClone(stored));
    return id;
  }
}

/** Append-only, minimal evidence ledger; no raw provider responses or usernames. */
export class SqliteEvidenceStore implements EvidenceStore {
  private db?: sqlite3.Database;
  constructor(private filename: string) {}
  async initialize(): Promise<void> {
    fs.mkdirSync(path.dirname(this.filename), { recursive: true });
    await new Promise<void>((resolve, reject) => {
      this.db = new sqlite3.Database(this.filename, (err) =>
        err ? reject(err) : resolve(),
      );
    });
    await applySqliteMigrations(this.db!, SQLITE_SCHEMA_MIGRATIONS['oracle-evidence']);
  }
  async history(gameId: string): Promise<Decision[]> {
    if (!this.db) throw new Error('Evidence store not initialized');
    return new Promise((resolve, reject) =>
      this.db!.all(
        'SELECT id, decision, hash FROM oracle_decisions WHERE gameId = ? ORDER BY id',
        [gameId],
        (err, rows: { id: number; decision: string; hash: string | null }[]) =>
          err
            ? reject(err)
            : resolve(
                rows.map((r) => {
                  const entry = { ...JSON.parse(r.decision), id: r.id } as Decision;
                  verifyDecisionHash(entry, r.hash ?? undefined);
                  return entry;
                }),
              ),
      ),
    );
  }
  async query(
    options: {
      gameId?: string;
      startTime?: number;
      endTime?: number;
    } = {},
  ): Promise<Decision[]> {
    if (!this.db) throw new Error('Evidence store not initialized');
    const sql = options.gameId
      ? 'SELECT id, decision, hash FROM oracle_decisions WHERE gameId = ? ORDER BY id'
      : 'SELECT id, decision, hash FROM oracle_decisions ORDER BY id';
    const params = options.gameId ? [options.gameId] : [];
    const rows = await new Promise<{ id: number; decision: string; hash: string | null }[]>(
      (resolve, reject) =>
        this.db!.all(sql, params, (err, result) => (err ? reject(err) : resolve(result))),
    );
    return rows
      .map((row) => {
        const entry = { ...JSON.parse(row.decision), id: row.id } as Decision;
        verifyDecisionHash(entry, row.hash ?? undefined);
        return entry;
      })
      .filter((entry) => {
        const recordedAt = Date.parse(entry.recordedAt);
        return (
          (options.startTime === undefined || recordedAt >= options.startTime) &&
          (options.endTime === undefined || recordedAt <= options.endTime)
        );
      });
  }
  async append(decision: Decision): Promise<number> {
    if (!this.db) throw new Error('Evidence store not initialized');
    validateDecision(decision);
    const hash = computeDecisionHash(decision);
    return new Promise((resolve, reject) =>
      this.db!.run(
        'INSERT INTO oracle_decisions(gameId, decision, hash) VALUES (?, ?, ?)',
        [decision.gameId, JSON.stringify(decision), hash],
        function (err) {
          if (err) reject(err);
          else resolve(this.lastID);
        },
      ),
    );
  }
  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      if (!this.db) return resolve();
      this.db.close((err) => (err ? reject(err) : resolve()));
    });
    this.db = undefined;
  }
}

/** Serialize verification and operator actions for the same game in this process. */
const locks = new Map<string, Promise<unknown>>();
export async function withGameLock<T>(
  gameId: string,
  action: () => Promise<T>,
): Promise<T> {
  const previous = locks.get(gameId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  locks.set(gameId, current);
  try {
    return await current;
  } finally {
    if (locks.get(gameId) === current) locks.delete(gameId);
  }
}
