import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import type { DlqEntry } from "../src/store/persistent-queue-store.js";
import { createMetricsRouter } from "../src/routes/metrics.js";
import { httpRequestMetrics } from "../src/middleware/http-metrics.js";
import { createHttpMetrics } from "../src/services/http-metrics.js";

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

  it("scrapes HTTP volume, duration histograms, and rolling percentiles", async () => {
    const metrics = createHttpMetrics(3);
    metrics.record("GET", "/things/:id", 200, 10);
    metrics.record("GET", "/things/:id", 200, 30);
    metrics.record("POST", "/things", 201, 20);

    const app = express();
    app.use(httpRequestMetrics(metrics));
    app.get("/things/:id", (_req, res) => res.status(200).send("ok"));
    app.post("/things", (_req, res) => res.status(201).send("created"));
    app.use(
      "/metrics",
      createMetricsRouter(async () => [], metrics),
    );

    await request(app).get("/things/one");
    await request(app).get("/things/two");
    const response = await request(app).get("/metrics");

    expect(response.status).toBe(200);
    expect(response.text).toContain(
      'http_requests_total{method="GET",route="/things/:id",status="200"} 4',
    );
    expect(response.text).toContain(
      'http_request_duration_seconds_count{method="GET",route="/things/:id",status="200"} 4',
    );
    expect(response.text).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/things/:id",status="200",le="+Inf"} 4',
    );
    expect(response.text).toContain(
      'http_request_duration_seconds_quantile{quantile="0.5"}',
    );
    expect(response.text).toContain(
      'http_request_duration_seconds_quantile{quantile="0.95"}',
    );
    expect(response.text).not.toContain('route="/metrics"');
    expect(response.text).toContain(
      "# HELP http_request_duration_seconds_quantile Exact response-time percentile in seconds over the most recent 3 completed requests",
    );
  });

  it("calculates percentiles from the most recent bounded sample window", () => {
    const metrics = createHttpMetrics(3);
    metrics.record("GET", "/same", 200, 10);
    metrics.record("GET", "/same", 200, 100);
    metrics.record("GET", "/same", 200, 20);
    metrics.record("GET", "/same", 200, 40);

    const output = metrics.render();
    expect(output).toContain(
      'http_request_duration_seconds_quantile{quantile="0.5"} 0.04',
    );
    expect(output).toContain(
      'http_request_duration_seconds_quantile{quantile="0.95"} 0.1',
    );
    expect(output).toContain(
      'http_request_duration_seconds_bucket{method="GET",route="/same",status="200",le="0.025"} 2',
    );
  });
});
