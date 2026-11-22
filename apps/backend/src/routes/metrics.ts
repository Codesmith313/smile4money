import { Router } from "express";
import { listDlqEntries } from "../queue.js";
import type { DlqEntry } from "../store/persistent-queue-store.js";

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

export function createMetricsRouter(
  loadEntries: () => Promise<DlqEntry[]> = listDlqEntries,
) {
  const router = Router();

  router.get("/", async (_req, res, next) => {
    try {
      const entries = await loadEntries();
      res.setHeader("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
      return res.status(200).send(renderDlqMetrics(entries));
    } catch (error) {
      return next(error);
    }
  });

  return router;
}

export default createMetricsRouter();
