import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import errorHandler from "../../src/middleware/error-handler.js";
import { traceContext } from "../../src/middleware/trace-context.js";

function createApp() {
  const app = express();
  app.use(traceContext());
  app.use(express.json());
  app.post("/json", (_req, res) => res.sendStatus(200));
  app.get("/unavailable", (_req, _res, next) => {
    next(Object.assign(new Error("private upstream details"), { status: 503 }));
  });
  app.use(errorHandler);
  return app;
}

describe("standard error handler", () => {
  it("returns a validation envelope and HTTP 400 for malformed JSON", async () => {
    const response = await request(createApp())
      .post("/json")
      .set("Content-Type", "application/json")
      .send("invalid json {");

    expect(response.status).toBe(400);
    expect(response.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.any(String),
      details: {},
      requestId: response.headers["x-request-id"],
      correlationId: response.headers["x-correlation-id"],
      timestamp: expect.any(String),
    });
  });

  it("preserves service-unavailable status without exposing internal details", async () => {
    const response = await request(createApp()).get("/unavailable");

    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: expect.any(String),
      details: {},
    });
    expect(JSON.stringify(response.body)).not.toContain(
      "private upstream details",
    );
  });
});
