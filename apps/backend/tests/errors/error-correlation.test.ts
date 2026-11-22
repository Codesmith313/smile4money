import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { ErrorCode, errorEnvelope } from "../../src/errors/errorResponse.js";
import { traceContext } from "../../src/middleware/trace-context.js";
import logger from "../../src/logger.js";

vi.mock("../../src/services/health-service.js", () => ({
  runHealthCheck: vi.fn(),
}));

import healthRouter from "../../src/routes/health.js";
import { runHealthCheck } from "../../src/services/health-service.js";

const mockRunHealthCheck = vi.mocked(runHealthCheck);

function createApp() {
  const app = express();
  app.use(traceContext());
  app.get("/error", (_req, res) => {
    logger.error({ status: 500 }, "http_error");
    res
      .status(500)
      .json(errorEnvelope(ErrorCode.INTERNAL_ERROR, "Try again later."));
  });
  app.use("/health", healthRouter);
  return app;
}

describe("error correlation metadata", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("matches the error body, response headers, and structured log identifiers", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(String(line));
    });

    const response = await request(createApp()).get("/error");
    const error = response.body.error;

    expect(error).toMatchObject({
      requestId: expect.stringMatching(/^[a-f0-9]{16}$/),
      correlationId: expect.stringMatching(/^[a-f0-9]{32}$/),
      timestamp: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(error.timestamp))).toBe(false);
    expect(response.headers["x-request-id"]).toBe(error.requestId);
    expect(response.headers["x-correlation-id"]).toBe(error.correlationId);

    const log = lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.message === "http_error");
    expect(log).toMatchObject({
      request_id: error.requestId,
      correlation_id: error.correlationId,
      trace_id: error.correlationId,
      span_id: error.requestId,
    });
  });

  it("adds IDs and timestamp to the legacy health-check 503 payload", async () => {
    mockRunHealthCheck.mockResolvedValue({
      ok: false,
      payload: {
        status: "error",
        uptime: 1,
        version: "test",
        error: "RPC unavailable",
        dependencies: { stellar_rpc: "unreachable" },
      },
    });

    const response = await request(createApp()).get("/health");
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({
      requestId: expect.stringMatching(/^[a-f0-9]{16}$/),
      correlationId: expect.stringMatching(/^[a-f0-9]{32}$/),
      timestamp: expect.any(String),
    });
    expect(response.headers["x-request-id"]).toBe(response.body.requestId);
    expect(response.headers["x-correlation-id"]).toBe(
      response.body.correlationId,
    );
  });
});
