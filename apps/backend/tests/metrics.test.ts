import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { DlqEntry } from "../src/store/persistent-queue-store.js";
import { createMetricsRouter } from "../src/routes/metrics.js";

const NOW = 100_000;

afterEach(() => {
  vi.useRealTimers();
});

function entry(id: string, createdAt: number, attempts: number): DlqEntry {
  return {
    id,
    payload: {},
    failureReason: "test failure",
    attempts,
    createdAt,
    lastAttemptAt: null,
  };
}

describe("GET /metrics", () => {
  it("exposes DLQ depth, oldest-entry age, and cumulative retry histogram", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);

    const app = express().use(
      "/metrics",
      createMetricsRouter(async () => [
        entry("never-retried", NOW - 18_000, 0),
        entry("retried-twice", NOW - 4_000, 2),
        entry("retried-seven-times", NOW - 1_000, 7),
      ]),
    );

    const response = await request(app).get("/metrics");
    expect(response.status).toBe(200);
    expect(response.headers["content-type"]).toMatch(
      /^text\/plain;.*version=0\.0\.4/,
    );
    expect(response.text).toContain("oracle_dlq_depth 3");
    expect(response.text).toContain("oracle_dlq_oldest_entry_age_seconds 18");
    expect(response.text).toContain(
      'oracle_dlq_retry_attempts_bucket{le="0"} 1',
    );
    expect(response.text).toContain(
      'oracle_dlq_retry_attempts_bucket{le="2"} 2',
    );
    expect(response.text).toContain(
      'oracle_dlq_retry_attempts_bucket{le="10"} 3',
    );
    expect(response.text).toContain(
      'oracle_dlq_retry_attempts_bucket{le="+Inf"} 3',
    );
    expect(response.text).toContain("oracle_dlq_retry_attempts_sum 9");
    expect(response.text).toContain("oracle_dlq_retry_attempts_count 3");
  });

  it("reports zero depth and age for an empty queue", async () => {
    const app = express().use(
      "/metrics",
      createMetricsRouter(async () => []),
    );

    const response = await request(app).get("/metrics");
    expect(response.status).toBe(200);
    expect(response.text).toContain("oracle_dlq_depth 0");
    expect(response.text).toContain("oracle_dlq_oldest_entry_age_seconds 0");
    expect(response.text).toContain("oracle_dlq_retry_attempts_count 0");
  });
});
