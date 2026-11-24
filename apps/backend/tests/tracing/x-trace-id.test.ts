import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import axios from "axios";
import logger from "../../src/logger.js";
import { traceContext } from "../../src/middleware/trace-context.js";
import { requestLogging } from "../../src/middleware/request-logging.js";
import { providerGet } from "../../src/fetchers/provider-validation.js";
import {
  currentTraceContext,
  runWithTraceContext,
  traceHeaders,
} from "../../src/tracing/trace-context.js";

const TRACE_ID = "4bf92f3577b34da6a3ce929d0e0e4736";
const OTHER_TRACE_ID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const TRACEPARENT = `00-${OTHER_TRACE_ID}-00f067aa0ba902b7-01`;

describe("X-Trace-ID propagation", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("generates a trace ID, returns it, and includes it in request logs", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(String(line));
    });
    const app = express();
    app.use(traceContext());
    app.use(requestLogging());
    app.get("/trace", (_req, res) => {
      logger.info({}, "trace_query_test");
      res.json(currentTraceContext());
    });

    const response = await request(app).get("/trace");
    const traceId = response.headers["x-trace-id"];
    const traceLog = lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.trace_id === traceId);
    const requestLog = lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.message === "http_request");

    expect(traceId).toMatch(/^[a-f0-9]{32}$/);
    expect(response.body.traceId).toBe(traceId);
    expect(response.headers["x-correlation-id"]).toBe(traceId);
    expect(traceLog).toBeDefined();
    expect(requestLog.trace_id).toBe(traceId);

    const secondResponse = await request(app).get("/trace");
    expect(secondResponse.headers["x-trace-id"]).not.toBe(traceId);
  });

  it("continues a valid X-Trace-ID when no valid traceparent is present", async () => {
    const app = express();
    app.use(traceContext());
    app.get("/trace", (_req, res) => res.json(currentTraceContext()));

    const response = await request(app)
      .get("/trace")
      .set("X-Trace-ID", TRACE_ID.toUpperCase());

    expect(response.headers["x-trace-id"]).toBe(TRACE_ID);
    expect(response.body.traceId).toBe(TRACE_ID);
  });

  it("prefers a valid W3C traceparent over a conflicting X-Trace-ID", async () => {
    const app = express();
    app.use(traceContext());
    app.get("/trace", (_req, res) => res.json(currentTraceContext()));

    const response = await request(app)
      .get("/trace")
      .set("traceparent", TRACEPARENT)
      .set("X-Trace-ID", TRACE_ID);

    expect(response.headers["x-trace-id"]).toBe(OTHER_TRACE_ID);
    expect(response.body.traceId).toBe(OTHER_TRACE_ID);
  });

  it("propagates the trace ID in downstream headers", async () => {
    const get = vi.spyOn(axios, "get").mockResolvedValue({
      status: 200,
      headers: {},
      data: {},
    });
    const ctx = {
      traceId: TRACE_ID,
      spanId: "0123456789abcdef",
      flags: "01",
    };

    await runWithTraceContext(ctx, () =>
      providerGet("https://provider.example/test", {
        headers: { Accept: "application/json" },
      }),
    );

    const headers = get.mock.calls[0][1]?.headers as Record<string, string>;
    expect(headers["x-trace-id"]).toBe(TRACE_ID);
    expect(headers.traceparent).toContain(TRACE_ID);
    expect(traceHeaders()).toEqual({});
  });
});
