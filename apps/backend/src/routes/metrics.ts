import { Router } from "express";
import { httpMetrics, type HttpMetrics } from "../services/http-metrics.js";
import type { DlqEntry } from "../store/persistent-queue-store.js";

const RETRY_ATTEMPT_BUCKETS = [0, 1, 2, 3, 5, 10, 25, 50, 100];
const RESPONSE_TIME_BUCKETS_MS = [50, 100, 250, 500, 1000, 2500, 5000, 10000];

export interface ProviderHealthSnapshot {
  provider: string;
  uptimeRatio: number;
  responseTimeCount: number;
  responseTimeSumMs: number;
  responseTimeBuckets: Record<string, number>;
  errorsTotal: number;
  cacheHitsTotal: number;
  cacheMissesTotal: number;
  cacheStaleTotal: number;
}

function escapeLabelValue(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n");
}

export function renderProviderMetrics(
  snapshots: readonly ProviderHealthSnapshot[],
): string {
  const lines = [
    "# HELP oracle_provider_uptime_ratio Fraction of successful health checks per provider.",
    "# TYPE oracle_provider_uptime_ratio gauge",
    "# HELP oracle_provider_response_time_ms Provider response time in milliseconds.",
    "# TYPE oracle_provider_response_time_ms histogram",
    "# HELP oracle_provider_errors_total Total provider errors observed.",
    "# TYPE oracle_provider_errors_total counter",
    "# HELP oracle_provider_cache_hits_total Total provider cache hits.",
    "# TYPE oracle_provider_cache_hits_total counter",
    "# HELP oracle_provider_cache_misses_total Total provider cache misses.",
    "# TYPE oracle_provider_cache_misses_total counter",
    "# HELP oracle_provider_cache_stale_total Total stale provider cache entries revalidated.",
    "# TYPE oracle_provider_cache_stale_total counter",
  ];

  for (const snapshot of snapshots) {
    const provider = escapeLabelValue(snapshot.provider);
    lines.push(
      `oracle_provider_uptime_ratio{provider="${provider}"} ${snapshot.uptimeRatio}`,
    );

    for (const bucket of RESPONSE_TIME_BUCKETS_MS) {
      const count = snapshot.responseTimeBuckets[String(bucket)] ?? 0;
      lines.push(
        `oracle_provider_response_time_ms_bucket{provider="${provider}",le="${bucket}"} ${count}`,
      );
    }
    lines.push(
      `oracle_provider_response_time_ms_bucket{provider="${provider}",le="+Inf"} ${snapshot.responseTimeCount}`,
      `oracle_provider_response_time_ms_sum{provider="${provider}"} ${snapshot.responseTimeSumMs}`,
      `oracle_provider_response_time_ms_count{provider="${provider}"} ${snapshot.responseTimeCount}`,
      `oracle_provider_errors_total{provider="${provider}"} ${snapshot.errorsTotal}`,
      `oracle_provider_cache_hits_total{provider="${provider}"} ${snapshot.cacheHitsTotal}`,
      `oracle_provider_cache_misses_total{provider="${provider}"} ${snapshot.cacheMissesTotal}`,
      `oracle_provider_cache_stale_total{provider="${provider}"} ${snapshot.cacheStaleTotal}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

export function renderDlqMetrics(
  entries: readonly DlqEntry[],
  nowMs = Date.now(),
): string {
  if (!Number.isFinite(nowMs)) {
    throw new Error("Metrics timestamp must be finite");
  }

  let oldestCreatedAt = Number.POSITIVE_INFINITY;
  let retryAttemptSum = 0;
  const attempts: number[] = [];

  for (const entry of entries) {
    if (!Number.isFinite(entry.createdAt)) {
      throw new Error(
        `DLQ entry ${entry.id} has an invalid creation timestamp`,
      );
    }
    if (!Number.isSafeInteger(entry.attempts) || entry.attempts < 0) {
      throw new Error(`DLQ entry ${entry.id} has an invalid retry count`);
    }
    oldestCreatedAt = Math.min(oldestCreatedAt, entry.createdAt);
    retryAttemptSum += entry.attempts;
    attempts.push(entry.attempts);
  }

  const depth = entries.length;
  const oldestAgeSeconds =
    depth === 0 ? 0 : Math.max(0, (nowMs - oldestCreatedAt) / 1000);
  const lines = [
    "# HELP oracle_dlq_depth Number of pending dead-letter queue entries.",
    "# TYPE oracle_dlq_depth gauge",
    `oracle_dlq_depth ${depth}`,
    "# HELP oracle_dlq_oldest_entry_age_seconds Age of the oldest pending dead-letter queue entry.",
    "# TYPE oracle_dlq_oldest_entry_age_seconds gauge",
    `oracle_dlq_oldest_entry_age_seconds ${oldestAgeSeconds}`,
    "# HELP oracle_dlq_retry_attempts Distribution of retry attempts recorded on pending dead-letter queue entries.",
    "# TYPE oracle_dlq_retry_attempts histogram",
  ];

  for (const bucket of RETRY_ATTEMPT_BUCKETS) {
    const count = attempts.filter((value) => value <= bucket).length;
    lines.push(`oracle_dlq_retry_attempts_bucket{le="${bucket}"} ${count}`);
  }
  lines.push(
    `oracle_dlq_retry_attempts_bucket{le="+Inf"} ${depth}`,
    `oracle_dlq_retry_attempts_sum ${retryAttemptSum}`,
    `oracle_dlq_retry_attempts_count ${depth}`,
  );

  return `${lines.join("\n")}\n`;
}

export function createMetricsRouter(
  loadEntries: () => Promise<DlqEntry[]> = async () => {
    const { listDlqEntries } = await import("../queue.js");
    return listDlqEntries();
  },
  metrics: HttpMetrics = httpMetrics,
  loadProviderHealth: () => Promise<ProviderHealthSnapshot[]> = async () => {
    const { getProviderHealthSnapshots } = await import(
      "../services/provider-health.js"
    );
    return getProviderHealthSnapshots();
  },
) {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const [entries, providerHealth] = await Promise.all([
        loadEntries(),
        loadProviderHealth(),
      ]);
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return res
        .status(200)
        .send(
          `${metrics.render()}${renderDlqMetrics(entries)}${renderProviderMetrics(providerHealth)}`,
        );
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export default createMetricsRouter();
