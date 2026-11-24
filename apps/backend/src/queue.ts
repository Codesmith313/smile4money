/**
 * Dead-letter queue (DLQ) for failed oracle submissions.
 *
 * Failed submissions are stored via a pluggable persistent store (in-memory by
 * default; swap to SQLite or MongoDB via the QUEUE_STORE env var). A retry
 * worker periodically attempts to reprocess each entry and emits
 * `oracle_dlq_depth` for monitoring.
 *
 * Circuit breaker pattern protects against cascading RPC failures:
 * - After N consecutive failures, job processing is paused
 * - Backoff cooldown prevents hammering a degraded endpoint
 * - Automatic recovery testing after cooldown expires
 */

/* Import already at the top level */
import { getCircuitBreaker, CircuitState } from "./services/circuit-breaker.js";
import { InMemoryQueueStore } from "./store/in-memory-queue-store.js";
import { SQLiteQueueStore } from "./store/sqlite-queue-store.js";
import type {
  DlqEntry,
  JobPriority,
  PersistentQueueStore,
} from "./store/persistent-queue-store.js";

export type { DlqEntry, JobPriority };

import logger from "./logger.js";

let queueStore: PersistentQueueStore | null = null;

/**
 * Queue monitoring metrics (#2179).
 *
 * Tracks queue depth, age of the oldest pending entry, and success rate.
 * Counters are process-local and reset on restart; the depth/age gauges are
 * refreshed from the store on every queue operation and by a periodic timer.
 */
export interface QueueMetricsSnapshot {
  /** Number of entries currently pending in the queue. */
  depth: number;
  /** Age in milliseconds of the oldest pending entry (0 when empty). */
  oldestEntryAgeMs: number;
  /** Successfully processed entries. */
  processed: number;
  /** Failed processing attempts. */
  failed: number;
  /** processed / (processed + failed); 1 when nothing has been attempted. */
  successRate: number;
  /** Timestamp of the last metrics refresh. */
  updatedAt: number;
}

const queueMetrics = {
  depth: 0,
  oldestEntryAgeMs: 0,
  processed: 0,
  failed: 0,
  updatedAt: Date.now(),
};

function computeSuccessRate(): number {
  const total = queueMetrics.processed + queueMetrics.failed;
  return total === 0 ? 1 : queueMetrics.processed / total;
}

/** Record that an entry was added to the queue. */
export function recordQueueEnqueue(): void {
  queueMetrics.updatedAt = Date.now();
}

/** Record that an entry was successfully processed and removed. */
export function recordQueueProcessed(): void {
  queueMetrics.processed += 1;
  queueMetrics.updatedAt = Date.now();
}

/** Record that processing an entry failed. */
export function recordQueueFailed(): void {
  queueMetrics.failed += 1;
  queueMetrics.updatedAt = Date.now();
}

/**
 * Recompute the depth and oldest-entry-age gauges from the store.
 * Safe to call when the store is not initialised (leaves gauges untouched).
 */
export async function refreshQueueMetrics(): Promise<void> {
  if (!queueStore) return;
  try {
    const entries = await queueStore.getAll();
    const now = Date.now();
    queueMetrics.depth = entries.length;
    queueMetrics.oldestEntryAgeMs =
      entries.length === 0
        ? 0
        : now - Math.min(...entries.map((entry) => entry.createdAt));
    queueMetrics.updatedAt = now;
  } catch (err) {
    logger.error({ err: String(err) }, "oracle_queue: metrics refresh failed");
  }
}

/** Return a snapshot of the current queue metrics. */
export function getQueueMetrics(): QueueMetricsSnapshot {
  return {
    depth: queueMetrics.depth,
    oldestEntryAgeMs: queueMetrics.oldestEntryAgeMs,
    processed: queueMetrics.processed,
    failed: queueMetrics.failed,
    successRate: computeSuccessRate(),
    updatedAt: queueMetrics.updatedAt,
  };
}

/** Reset all queue metrics (used by tests). */
export function resetQueueMetrics(): void {
  queueMetrics.depth = 0;
  queueMetrics.oldestEntryAgeMs = 0;
  queueMetrics.processed = 0;
  queueMetrics.failed = 0;
  queueMetrics.updatedAt = Date.now();
}

const DEFAULT_QUEUE_METRICS_INTERVAL_MS = 15_000;

/**
 * Start a periodic timer that refreshes the queue gauges so depth and
 * oldest-entry age stay current even when the queue is idle.
 * Returns a cleanup function that stops the timer.
 */
export function startQueueMetricsTask(
  intervalMs = DEFAULT_QUEUE_METRICS_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    void refreshQueueMetrics();
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  return () => clearInterval(timer);
}

export type QueueStoreType = "memory" | "sqlite";

/**
 * Decide which queue store implementation to use for a given QUEUE_STORE
 * value and NODE_ENV, without touching disk. Exported for unit testing.
 *
 *   'sqlite' / 'auto' / unset → sqlite (durable; the default)
 *   'mongodb'                 → sqlite (mongoose is not an installed dependency)
 *   'memory'                  → memory, EXCEPT in production, where it is
 *                                auto-corrected to sqlite so DLQ entries
 *                                cannot silently be lost on restart.
 */
export function resolveQueueStoreType(
  rawQueueStore: string | undefined,
  nodeEnv: string | undefined,
): QueueStoreType {
  const requested = (rawQueueStore || "auto").toLowerCase();

  if (requested === "memory" && nodeEnv !== "production") {
    return "memory";
  }

  return "sqlite";
}

/**
 * Initialise the queue store based on the QUEUE_STORE environment variable.
 * Must be called once on application startup before any other queue function.
 *
 * See resolveQueueStoreType() for how QUEUE_STORE is resolved. In-memory
 * mode is never durable across restarts, so it always logs a warning, and
 * NODE_ENV=production silently requesting it is auto-corrected to SQLite
 * (see docs/oracle.md#queue-store-persistence).
 */
// Maintenance gate for live restores (#108); see store/maintenance-gate.ts.
import { MaintainableQueueStore } from "./store/maintenance-gate.js";

/**
 * The active queue store's maintenance gate, or null before initializeQueue().
 * Used by the live-restore procedure (store/live-restore.ts) to hold queue
 * access while the database file is replaced.
 */
export function getMaintainableQueueStore(): MaintainableQueueStore | null {
  return queueStore instanceof MaintainableQueueStore ? queueStore : null;
}

export async function initializeQueue(): Promise<void> {
  const rawQueueStore = process.env.QUEUE_STORE;
  const nodeEnv = process.env.NODE_ENV;
  const requested = (rawQueueStore || "auto").toLowerCase();
  const resolved = resolveQueueStoreType(rawQueueStore, nodeEnv);

  if (requested === "mongodb") {
    logger.warn(
      { requested },
      "oracle_dlq: QUEUE_STORE=mongodb requested but the mongoose dependency is not installed; falling back to sqlite",
    );
  }

  if (requested === "memory" && resolved === "sqlite") {
    logger.warn(
      { requested, nodeEnv },
      "oracle_dlq: QUEUE_STORE=memory is not safe in production (DLQ entries are lost on restart); auto-falling back to sqlite. See docs/oracle.md#queue-store-persistence.",
    );
  }

  // Wrapped so a live restore can quiesce every queue read/write (#108).
  queueStore = new MaintainableQueueStore(
    resolved === "memory" ? new InMemoryQueueStore() : new SQLiteQueueStore(),
  );

  await queueStore.initialize();

  if (resolved === "memory") {
    logger.warn(
      {},
      "oracle_dlq: using in-memory queue store -- DLQ entries will NOT survive a process restart. Not recommended outside local development; see docs/oracle.md#queue-store-persistence.",
    );
  }

  logger.info({ store: resolved }, "oracle_dlq: queue store initialized");

  await refreshQueueMetrics();
}

/**
 * Return the active queue store.
 * @throws if initializeQueue() has not been called yet.
 */
function getQueueStore(): PersistentQueueStore {
  if (!queueStore) {
    throw new Error(
      "Queue store not initialized. Call initializeQueue() first.",
    );
  }
  return queueStore;
}

/** Write a failed submission to the DLQ. */
export async function writeToDlq(
  payload: unknown,
  failureReason: string,
  priority: JobPriority = "medium",
): Promise<DlqEntry> {
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const entry: DlqEntry = {
    id,
    payload,
    failureReason,
    attempts: 0,
    createdAt: Date.now(),
    lastAttemptAt: null,
    priority,
  };

  await getQueueStore().add(entry);
  logger.warn({ dlqId: id, failureReason }, "oracle_dlq: entry written");
  recordQueueEnqueue();
  await emitDlqDepth();
  return entry;
}

/** Return all pending DLQ entries (shallow copy). */
export async function listDlqEntries(): Promise<DlqEntry[]> {
  return await getQueueStore().getAll();
}

/** Remove a successfully processed entry. */
export async function removeDlqEntry(id: string): Promise<void> {
  await getQueueStore().remove(id);
  recordQueueProcessed();
  await emitDlqDepth();
}

/** Update an entry's retry state. */
export async function updateDlqEntry(
  id: string,
  updates: Partial<DlqEntry>,
): Promise<void> {
  await getQueueStore().update(id, updates);
}

/** Emit the oracle_dlq_depth metric and refresh queue gauges. */
async function emitDlqDepth(): Promise<void> {
  const depth = await getQueueStore().count();
  logger.info({ metric: "oracle_dlq_depth", value: depth }, "oracle_dlq_depth");
  await refreshQueueMetrics();
}

export type RetryHandler = (entry: DlqEntry) => Promise<void>;

/** Exponential backoff parameters for a job type. */
export interface BackoffConfig {
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
}

/** Default backoff configuration used when no per-type override applies. */
export const DEFAULT_BACKOFF_CONFIG: BackoffConfig = {
  baseDelayMs: 1_000,
  maxDelayMs: 60_000,
  multiplier: 2,
};

function parsePositiveNumber(
  rawValue: string | undefined,
  fallback: number,
  label: string,
): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { rawValue, label },
      "oracle_dlq: invalid backoff value, falling back to default",
    );
    return fallback;
const DEFAULT_BATCH_SIZE = 10;

/**
 * Parse the DLQ_BATCH_SIZE environment variable, falling back to the default
 * (10) when unset or invalid (non-numeric, zero, or negative).
 */
export function parseBatchSize(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_BATCH_SIZE;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
    logger.warn(
      { rawValue },
      "oracle_dlq: invalid DLQ_BATCH_SIZE, falling back to default of 10",
    );
    return DEFAULT_BATCH_SIZE;
  }

  return parsed;
}

/**
 * Resolve the exponential backoff configuration for a job type.
 *
 * Per-type overrides are read from the environment using the job type
 * uppercased with non-alphanumerics replaced by underscores, e.g. for
 * jobType "oracle-submit":
 *
 *   BACKOFF_ORACLE_SUBMIT_BASE_DELAY_MS
 *   BACKOFF_ORACLE_SUBMIT_MAX_DELAY_MS
 *   BACKOFF_ORACLE_SUBMIT_MULTIPLIER
 *
 * Global overrides (BACKOFF_BASE_DELAY_MS, BACKOFF_MAX_DELAY_MS,
 * BACKOFF_MULTIPLIER) apply to all job types; per-type values win.
 */
export function resolveBackoffConfig(
  jobType: string,
  env: NodeJS.ProcessEnv = process.env,
): BackoffConfig {
  const prefix = `BACKOFF_${jobType
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "_")}`;

  const baseDelayMs = parsePositiveNumber(
    env[`${prefix}_BASE_DELAY_MS`] ?? env.BACKOFF_BASE_DELAY_MS,
    DEFAULT_BACKOFF_CONFIG.baseDelayMs,
    "baseDelayMs",
  );
  const maxDelayMs = parsePositiveNumber(
    env[`${prefix}_MAX_DELAY_MS`] ?? env.BACKOFF_MAX_DELAY_MS,
    DEFAULT_BACKOFF_CONFIG.maxDelayMs,
    "maxDelayMs",
  );
  const multiplier = parsePositiveNumber(
    env[`${prefix}_MULTIPLIER`] ?? env.BACKOFF_MULTIPLIER,
    DEFAULT_BACKOFF_CONFIG.multiplier,
    "multiplier",
  );

  return { baseDelayMs, maxDelayMs, multiplier };
}

/**
 * Compute the exponential backoff delay for the given (1-based) attempt
 * number and job type: min(baseDelayMs * multiplier^(attempt-1), maxDelayMs).
 */
export function computeBackoffDelay(
  attempt: number,
  jobType: string,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const { baseDelayMs, maxDelayMs, multiplier } = resolveBackoffConfig(
    jobType,
    env,
  );
  const exponent = Math.max(0, attempt - 1);
  const delay = baseDelayMs * Math.pow(multiplier, exponent);
  return Math.min(delay, maxDelayMs);
export interface BatchResult {
  /** Entries that were successfully processed and removed. */
  resolved: string[];
  /** Entries whose handler failed (kept in the DLQ for a later retry). */
  failed: string[];
  /** True when the whole batch was rolled back. */
  rolledBack: boolean;
}

/**
 * Process a batch of DLQ entries in a single atomic unit of work.
 *
 * Entries are removed only after every handler succeeds. If a handler throws,
 * the batch is rolled back and remains pending, while attempts already made
 * are persisted for retry monitoring and backoff decisions.
 */
export async function processBatch(
  entries: DlqEntry[],
  handler: RetryHandler,
): Promise<BatchResult> {
  const store = getQueueStore();
  const resolved: string[] = [];
  const failed: string[] = [];

  if (entries.length === 0) {
    return { resolved, failed, rolledBack: false };
  }

  const staged: Array<{ id: string; updates: Partial<DlqEntry> }> = [];

  try {
    for (const entry of entries) {
      const attempts = entry.attempts + 1;
      const lastAttemptAt = Date.now();
      staged.push({ id: entry.id, updates: { attempts, lastAttemptAt } });

      await handler({ ...entry, attempts, lastAttemptAt });
      resolved.push(entry.id);
    }
  } catch (err) {
    // Keep attempted retry counts even though no entries are removed.
    for (const { id, updates } of staged) {
      await store.update(id, updates);
    }
    logger.error(
      {
        batchSize: entries.length,
        resolved: resolved.length,
        err: String(err).substring(0, 100),
      },
      "oracle_dlq: batch rolled back",
    );
    return { resolved: [], failed: entries.map((e) => e.id), rolledBack: true };
  }

  // Commit phase: persist retry state and remove resolved entries.
  for (const { id, updates } of staged) {
    await store.update(id, updates);
  }
  for (const id of resolved) {
    await store.remove(id);
  }

  return { resolved, failed, rolledBack: false };
}

/**
 * Start the DLQ retry worker. Call once on startup.
 * Returns a cleanup function that stops the worker.
 *
 * Implements a circuit breaker to prevent cascading failures:
 * - Circuit opens after N consecutive RPC failures
 * - Job processing pauses during cooldown
 * - Exponential backoff for recovery attempts
 */
export function startRetryWorker(
  handler: RetryHandler,
  intervalMs = 60_000,
  jobType = "default",
): () => void {
  const breaker = getCircuitBreaker();

  // Wrap the circuit breaker's state-change callback so we can log transitions
  const originalOnStateChange = breaker["config"].onStateChange;
  breaker["config"].onStateChange = (from: CircuitState, to: CircuitState) => {
    if (from !== to) {
      logger.warn(
        { from, to, ...breaker.getStatus() },
        "circuit_breaker: state changed",
      );
    }
    originalOnStateChange?.(from, to);
  };

  const timer = setInterval(async () => {
    const entries = await listDlqEntries();
    if (entries.length === 0) return;

    // Respect circuit breaker state
    if (!breaker.allowRequest()) {
      const remaining = breaker.getRemainingCooldown();
      logger.warn(
        { remaining, state: breaker.getState(), count: entries.length },
        "circuit_breaker: job processing paused",
      );
      return;
    }

    const batchSize =
      breaker.getState() === CircuitState.HALF_OPEN
        ? 1
        : parseBatchSize(process.env.DLQ_BATCH_SIZE);
    const batch = entries.slice(0, batchSize);

    logger.info(
      { count: entries.length, batchSize: batch.length, state: breaker.getState() },
      "oracle_dlq: retry worker running",
    );

    try {
      const result = await processBatch(batch, handler);

        try {
          await handler(entry);
          await removeDlqEntry(entry.id);
          breaker.recordSuccess();
          logger.info({ dlqId: entry.id }, "oracle_dlq: entry resolved");
        } catch (err) {
          recordQueueFailed();
          const isRpcError =
            String(err).includes("RPC") || String(err).includes("Network");

          if (isRpcError) {
            const circuitOpened = breaker.recordFailure();
            if (circuitOpened) {
              logger.error(
                {
                  dlqId: entry.id,
                  attempt: entry.attempts,
                  failureCount: breaker.getFailureCount(),
                  cooldown: breaker.getRemainingCooldown(),
                },
                "circuit_breaker: RPC circuit opened, pausing job processing",
              );
              // Stop processing remaining entries this cycle
              break;
            }
      if (result.rolledBack) {
        // Treat a rolled-back batch as a failure for circuit-breaker purposes.
        const isRpcError = result.failed.some((id) => {
          const entry = batch.find((e) => e.id === id);
          return entry !== undefined && entry.attempts >= 0;
        });
        if (isRpcError) {
          const circuitOpened = breaker.recordFailure();
          if (circuitOpened) {
            logger.error(
              {
                failureCount: breaker.getFailureCount(),
                cooldown: breaker.getRemainingCooldown(),
              },
              "circuit_breaker: RPC circuit opened, pausing job processing",
            );
          }

          const nextDelayMs = computeBackoffDelay(entry.attempts, jobType);

          logger.warn(
            {
              dlqId: entry.id,
              attempt: entry.attempts,
              isRpcError,
              nextDelayMs,
              err: String(err).substring(0, 100),
            },
            "oracle_dlq: retry failed",
          );
        }
      } else {
        for (const id of result.resolved) {
          breaker.recordSuccess();
          logger.info({ dlqId: id }, "oracle_dlq: entry resolved");
        }
      }

      logger.info(
        {
          batchSize: batch.length,
          resolved: result.resolved.length,
          failed: result.failed.length,
          rolledBack: result.rolledBack,
        },
        "oracle_dlq: batch processed",
      );

      await emitDlqDepth();
    } catch (err) {
      logger.error({ err: String(err) }, "oracle_dlq: retry worker error");
    }
  }, intervalMs);

  return () => {
    clearInterval(timer);
  };
}

/**
 * Shut down the queue store cleanly on application exit.
 */
export async function closeQueue(): Promise<void> {
  if (queueStore) {
    await queueStore.close();
    queueStore = null;
  }
}

const DEFAULT_DLQ_TTL_DAYS = 7;
const DEFAULT_DLQ_EVICTION_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h

/**
 * Parse the DLQ_TTL_DAYS environment variable, falling back to the default
 * (7 days) when unset or invalid (non-numeric, zero, or negative).
 */
export function parseDlqTtlDays(rawValue: string | undefined): number {
  if (rawValue === undefined || rawValue.trim() === "") {
    return DEFAULT_DLQ_TTL_DAYS;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    logger.warn(
      { rawValue },
      "oracle_dlq: invalid DLQ_TTL_DAYS, falling back to default of 7 days",
    );
    return DEFAULT_DLQ_TTL_DAYS;
  }

  return parsed;
}

/**
 * Delete DLQ entries older than the configured TTL (DLQ_TTL_DAYS, default 7
 * days). Logs the number of entries deleted. Returns that count.
 */
export async function evictExpiredDlqEntries(
  ttlDays: number = parseDlqTtlDays(process.env.DLQ_TTL_DAYS),
): Promise<number> {
  const cutoff = Date.now() - ttlDays * 24 * 60 * 60 * 1000;

  try {
    const deleted = await getQueueStore().deleteExpired(cutoff);

    logger.info(
      { deleted, ttlDays },
      "oracle_dlq: TTL eviction run complete",
    );

    await emitDlqDepth();
    return deleted;
  } catch (err) {
    logger.error(
      { err: String(err), ttlDays },
      "oracle_dlq: TTL eviction run failed",
    );
    throw err;
  }
}

/**
 * Start the periodic DLQ TTL eviction task. Call once on startup.
 * Returns a cleanup function that stops the task.
 */
export function startDlqEvictionTask(
  intervalMs = DEFAULT_DLQ_EVICTION_INTERVAL_MS,
): () => void {
  const timer = setInterval(() => {
    evictExpiredDlqEntries().catch((err) => {
      logger.error({ err: String(err) }, "oracle_dlq: TTL eviction run failed");
    });
  }, intervalMs);

  return () => clearInterval(timer);
}
