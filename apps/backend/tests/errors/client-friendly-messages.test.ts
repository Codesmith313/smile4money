import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { apiErrorHandler } from "../../src/middleware/error-handler.js";
import { traceContext } from "../../src/middleware/trace-context.js";

function createApp() {
  const app = express();
  app.use(traceContext());
  app.get("/invalid", (_req, _res, next) => {
    next(
      Object.assign(new Error("SQL constraint failed for game_id"), {
        status: 400,
        details: { field: "gameId" },
      }),
    );
  });
  app.get("/unavailable", (_req, _res, next) => {
    next(
      Object.assign(new Error("upstream connection pool exhausted"), {
        status: 503,
        details: { provider: "chess service" },
      }),
    );
  });
  app.get("/failure", (_req, _res, next) => {
    next(new Error("database credentials rejected"));
  });
  app.use(apiErrorHandler);
  return app;
}

describe("client-friendly error messages", () => {
  it("maps client errors to clear guidance and retains safe error context", async () => {
    const response = await request(createApp()).get("/invalid").expect(400);

    expect(response.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Check the request details and try again.",
      details: { field: "gameId" },
      requestId: response.headers["x-request-id"],
      correlationId: response.headers["x-correlation-id"],
    });
    expect(response.text).not.toContain("SQL constraint failed");
  });

  it("maps upstream failures without returning technical exception details", async () => {
    const response = await request(createApp()).get("/unavailable").expect(503);

    expect(response.body.error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message:
        "The service is temporarily unavailable. Please try again shortly.",
    });
    expect(response.text).not.toContain("upstream connection pool exhausted");
    expect(response.text).not.toContain("chess service");
  });

  it("uses a safe retry message for unexpected server errors", async () => {
    const response = await request(createApp()).get("/failure").expect(500);

    expect(response.body.error.message).toBe(
      "Something went wrong. Please try again later.",
    );
    expect(response.text).not.toContain("database credentials rejected");
    expect(response.body.error.requestId).toBe(
      response.headers["x-request-id"],
    );
  });
});
