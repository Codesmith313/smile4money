/**
 * Persistent Queue Store Interface
 *
 * Defines the contract for storing oracle job queue entries durably.
 * Implementations can use MongoDB, PostgreSQL, SQLite, or other data stores.
 */

import type { PersistedTraceContext } from "../tracing/trace-context.js";

/** Processing urgency for a DLQ entry. High-priority entries are processed before medium, medium before low. */
export type JobPriority = "high" | "medium" | "low";

/** Numeric weight used for in-process sorting: lower number = processed first. */
export const PRIORITY_ORDER: Record<JobPriority, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

export interface DlqEntry {
  id: string;
  payload: unknown;
  failureReason: string;
  attempts: number;
  createdAt: number;
  lastAttemptAt: number | null;
  /**
   * Processing priority for this entry. High-priority entries are dequeued
   * before medium, and medium before low. Defaults to 'medium' when absent
   * (entries written before this field existed are treated as medium).
   */
  priority?: JobPriority;
  /**
   * W3C trace context the entry was queued under (#123), resumed as a child
   * span on every retry. Holds only `traceparent`/`tracestate`: random ids and
   * a sanitised vendor list, never payload data or credentials. Absent on
   * entries written before this field existed.
   */
  traceContext?: PersistedTraceContext;
}

export interface PersistentQueueStore {
  /**
   * Write an entry to the queue.
   * Implementations must ensure this is atomic and durable: once the promise
   * resolves the entry must survive a process restart.
   */
  add(entry: DlqEntry): Promise<void>;

  /**
   * Retrieve all entries from the queue.
   * Should return shallow copies to prevent accidental mutations.
   * Must reflect all durably persisted entries.
   */
  getAll(): Promise<DlqEntry[]>;

  /**
   * Remove an entry by ID.
   * Should be idempotent (safe to call for non-existent IDs).
   * The removal must be durable once the promise resolves.
   */
  remove(id: string): Promise<void>;

  /**
   * Update an entry (used to record retry attempts).
   * Merges the provided fields with the existing entry.
   * The update must be durable once the promise resolves.
   */
  update(id: string, updates: Partial<DlqEntry>): Promise<void>;

  /**
   * Delete all entries whose `createdAt` is older than the given cutoff
   * (epoch milliseconds). Used by the DLQ TTL expiration job.
   * Returns the number of entries deleted. Deletions must be durable.
   */
  deleteExpired(olderThanMs: number): Promise<number>;

  /**
   * Get count of entries in the queue.
   */
  count(): Promise<number>;

  /**
   * Clear all entries (useful for testing and manual intervention).
   */
  clear(): Promise<void>;

  /**
   * Initialize the store (create tables, indices, etc.).
   * Called on application startup.
   */
  initialize(): Promise<void>;

  /**
   * Close the store connection(s).
   * Called on application shutdown.
   */
  close(): Promise<void>;
}

/**
 * Error thrown when a queue entry cannot be found by ID.
 */
export class NotFoundError extends Error {
  constructor(id: string) {
    super(`Queue entry not found: ${id}`);
    this.name = "NotFoundError";
  }
}

/**
 * Error thrown when a queue entry is not in a replayable (failed) state.
 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
  }
}

/**
 * Minimal structured logger contract used by the replay flow.
 */
export interface ReplayLogger {
  info(event: string, fields?: Record<string, unknown>): void;
  error(event: string, fields?: Record<string, unknown>): void;
}

const defaultLogger: ReplayLogger = {
  info(event, fields) {
    console.info(JSON.stringify({ level: "info", event, ...fields }));
  },
  error(event, fields) {
    console.error(JSON.stringify({ level: "error", event, ...fields }));
  },
};

/**
 * Determine whether an entry is in a failed state and therefore replayable.
 * An entry is considered failed when it has recorded at least one failed
 * attempt and is not currently mid-replay.
 */
export function isFailedEntry(entry: DlqEntry): boolean {
  if (entry.replayResult === "pending") {
    return false;
  }
  return entry.attempts > 0 && entry.lastAttemptAt !== null;
}

/**
 * Manually replay a failed queue entry (#2184).
 *
 * Looks up the entry by ID, verifies it exists and is in a failed state,
 * resets its attempts/lastAttemptAt to a fresh pending state (as if newly
 * enqueued), re-adds it to the store, and records replay metadata
 * (`replayedAt`, `replayResult`) for the audit trail.
 *
 * Emits structured log events for replay start and outcome.
 *
 * @throws {NotFoundError} when no entry exists for `id`.
 * @throws {ConflictError} when the entry is not in a failed state.
 */
export async function replayDlqEntry(
  store: PersistentQueueStore,
  id: string,
  logger: ReplayLogger = defaultLogger,
): Promise<DlqEntry> {
  logger.info("queue.replay.started", { entryId: id });

  const entries = await store.getAll();
  const existing = entries.find((entry) => entry.id === id);

  if (!existing) {
    logger.error("queue.replay.not_found", { entryId: id });
    throw new NotFoundError(id);
  }

  if (!isFailedEntry(existing)) {
    logger.error("queue.replay.conflict", {
      entryId: id,
      attempts: existing.attempts,
      lastAttemptAt: existing.lastAttemptAt,
      replayResult: existing.replayResult ?? null,
    });
    throw new ConflictError(
      `Queue entry ${id} is not in a failed state and cannot be replayed`,
    );
  }

  const replayedAt = Date.now();
  const replayed: DlqEntry = {
    ...existing,
    attempts: 0,
    lastAttemptAt: null,
    replayedAt,
    replayResult: "pending",
  };

  try {
    // Re-add as if newly enqueued: remove the stale record first so the
    // store treats this as a fresh entry, then persist the reset entry.
    await store.remove(id);
    await store.add(replayed);
  } catch (error) {
    logger.error("queue.replay.failed", {
      entryId: id,
      replayedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }

  logger.info("queue.replay.succeeded", {
    entryId: id,
    replayedAt,
    replayResult: replayed.replayResult,
  });

  return replayed;
}
