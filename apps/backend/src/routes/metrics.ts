import { Router } from "express";
import { httpMetrics, type HttpMetrics } from "../services/http-metrics.js";
import type { DlqEntry } from "../store/persistent-queue-store.js";
import {
  oracleMetrics,
  type OracleMetricsSnapshot,
  type OracleOperationMetrics,
} from "../services/oracle-metrics.js";

const RETRY_ATTEMPT_BUCKETS = [0, 1, 2, 3, 5, 10, 25, 50, 100];

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

export function renderOracleMetrics(snapshot: OracleMetricsSnapshot): string {
  const lines: string[] = [];

  lines.push(
    "# HELP oracle_operation_submissions_total Total result submissions per operation type.",
    "# TYPE oracle_operation_submissions_total counter",
  );
  for (const op of snapshot.operations) {
    lines.push(
      `oracle_operation_submissions_total{operation="${op.operation}"} ${op.submissions}`,
    );
  }

  lines.push(
    "# HELP oracle_operation_successes_total Total successful result submissions per operation type.",
    "# TYPE oracle_operation_successes_total counter",
  );
  for (const op of snapshot.operations) {
    lines.push(
      `oracle_operation_successes_total{operation="${op.operation}"} ${op.successes}`,
    );
  }

  lines.push(
    "# HELP oracle_operation_failures_total Total failed result submissions per operation type.",
    "# TYPE oracle_operation_failures_total counter",
  );
  for (const op of snapshot.operations) {
    lines.push(
      `oracle_operation_failures_total{operation="${op.operation}"} ${op.failures}`,
    );
  }

  lines.push(
    "# HELP oracle_operation_success_rate Ratio of successful submissions per operation type.",
    "# TYPE oracle_operation_success_rate gauge",
  );
  for (const op of snapshot.operations) {
    lines.push(
      `oracle_operation_success_rate{operation="${op.operation}"} ${op.successRate}`,
    );
  }

  lines.push(
    "# HELP oracle_operation_submissions_per_hour Submissions per hour per operation type.",
    "# TYPE oracle_operation_submissions_per_hour gauge",
  );
  for (const op of snapshot.operations) {
    lines.push(
      `oracle_operation_submissions_per_hour{operation="${op.operation}"} ${op.submissionsPerHour}`,
    );
  }

  const quantiles: Array<[string, (op: OracleOperationMetrics) => number]> = [
    ["p50", (op) => op.latency.p50],
    ["p95", (op) => op.latency.p95],
    ["p99", (op) => op.latency.p99],
  ];
  lines.push(
    "# HELP oracle_operation_latency_ms Result submission latency in milliseconds per operation type.",
    "# TYPE oracle_operation_latency_ms gauge",
  );
  for (const op of snapshot.operations) {
    for (const [quantile, getValue] of quantiles) {
      lines.push(
        `oracle_operation_latency_ms{operation="${op.operation}",quantile="${quantile}"} ${getValue(op)}`,
      );
    }
  }

  lines.push(
    "# HELP oracle_operation_latency_samples Number of latency samples recorded per operation type.",
    "# TYPE oracle_operation_latency_samples gauge",
  );
  for (const op of snapshot.operations) {
    lines.push(
      `oracle_operation_latency_samples{operation="${op.operation}"} ${op.latency.samples}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

export function createMetricsRouter(
  loadEntries: () => Promise<DlqEntry[]> = async () => {
    const { listDlqEntries } = await import("../queue.js");
    return listDlqEntries();
  },
  metrics: HttpMetrics = httpMetrics,
  loadOracleSnapshot: () => OracleMetricsSnapshot = () =>
    oracleMetrics.snapshot(),
) {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const entries = await loadEntries();
      const oracleSnapshot = loadOracleSnapshot();
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return res
        .status(200)
        .send(
          `${metrics.render()}${renderDlqMetrics(entries)}${renderOracleMetrics(oracleSnapshot)}`,
        );
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export default createMetricsRouter();
