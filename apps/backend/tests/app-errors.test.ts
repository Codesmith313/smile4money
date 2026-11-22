import { afterEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { app } from "../src/app.js";

describe("application error responses", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns safe error context that matches the structured error log", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: string) => {
      lines.push(String(line));
    });

    const response = await request(app)
      .post("/not-a-route")
      .set("Content-Type", "application/json")
      .send("{");

    expect(response.status).toBe(500);
    expect(response.body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "Something went wrong. Please try again later.",
      requestId: expect.stringMatching(/^[a-f0-9]{16}$/),
      correlationId: expect.stringMatching(/^[a-f0-9]{32}$/),
      timestamp: expect.any(String),
    });
    expect(response.headers["x-request-id"]).toBe(
      response.body.error.requestId,
    );
    expect(response.headers["x-correlation-id"]).toBe(
      response.body.error.correlationId,
    );
    expect(response.text).not.toContain("Unexpected end of JSON input");

    const errorLog = lines
      .map((line) => JSON.parse(line))
      .find((entry) => entry.message === "http_error");
    expect(errorLog).toMatchObject({
      request_id: response.body.error.requestId,
      correlation_id: response.body.error.correlationId,
      trace_id: response.body.error.correlationId,
      span_id: response.body.error.requestId,
    });
  });

  it("uses the standard envelope and context for unmatched routes", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const response = await request(app).get("/not-a-route");

    expect(response.status).toBe(404);
    expect(response.body.error).toMatchObject({
      code: "NOT_FOUND",
      requestId: expect.stringMatching(/^[a-f0-9]{16}$/),
      correlationId: expect.stringMatching(/^[a-f0-9]{32}$/),
      timestamp: expect.any(String),
    });
    expect(response.headers["x-request-id"]).toBe(
      response.body.error.requestId,
    );
    expect(response.headers["x-correlation-id"]).toBe(
      response.body.error.correlationId,
    );
  });
});
