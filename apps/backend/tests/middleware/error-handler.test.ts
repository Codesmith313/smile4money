import { afterEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { apiErrorHandler } from "../../src/middleware/error-handler.js";
import {
  ValidationError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  RateLimitError,
  errorToHttpStatus,
} from "../../src/errors/errorToHttpStatus.js";
import {
  errorResponse,
  statusToErrorCode,
} from "../../src/errors/errorResponse.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it("logs unhandled server errors with structured stack metadata and returns safe recovery guidance", async () => {
  vi.stubEnv("LOG_LEVEL", "debug");
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value) =>
    lines.push(String(value)),
  );
  const app = express();
  app.get("/failure", () => {
    throw new Error("Bearer token-secret email-secret@example.com");
  });
  app.use(apiErrorHandler);

  const response = await request(app).get("/failure").expect(500);

  expect(response.body.error).toMatchObject({
    code: "INTERNAL_ERROR",
    message: "An unexpected server error occurred.",
    suggestion: expect.stringContaining("Retry once"),
    documentation: expect.stringContaining(
      "api-reference.md#recovering-from-errors",
    ),
  });
  expect(response.body.error.message).not.toContain("token-secret");
  const log = JSON.parse(lines[0]);
  expect(log).toMatchObject({
    level: "error",
    severity: "error",
    message: "http_request_failed",
    status: 500,
    method: "GET",
    error: { type: "Error" },
  });
  expect(log.error.stack.length).toBeGreaterThan(0);
  expect(lines.join("")).not.toMatch(/token-secret|email-secret@example\.com/);
});

describe("errorResponse", () => {
  it("builds the canonical error envelope with code, message, and details", () => {
    const body = errorResponse("VALIDATION_ERROR", "invalid field", {
      field: "email",
    });

    expect(body).toEqual({
      error: {
        code: "VALIDATION_ERROR",
        message: "invalid field",
        details: { field: "email" },
      },
    });
  });

  it("includes an empty details object when none are provided", () => {
    const body = errorResponse("INTERNAL_ERROR", "boom");

    expect(body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "boom",
    });
    expect(body.error).toHaveProperty("details");
  });
});

describe("statusToErrorCode", () => {
  it.each([
    [400, "VALIDATION_ERROR"],
    [401, "UNAUTHORIZED"],
    [403, "FORBIDDEN"],
    [404, "NOT_FOUND"],
    [409, "CONFLICT"],
    [429, "RATE_LIMITED"],
    [500, "INTERNAL_ERROR"],
    [503, "SERVICE_UNAVAILABLE"],
  ])("maps status %i to %s", (status, code) => {
    expect(statusToErrorCode(status)).toBe(code);
  });

  it("falls back to INTERNAL_ERROR for unknown statuses", () => {
    expect(statusToErrorCode(418)).toBe("INTERNAL_ERROR");
  });
});

describe("errorToHttpStatus", () => {
  it.each([
    [new ValidationError("bad"), 400],
    [new UnauthorizedError("nope"), 401],
    [new ForbiddenError("denied"), 403],
    [new NotFoundError("missing"), 404],
    [new ConflictError("dup"), 409],
    [new RateLimitError("slow down"), 429],
  ])("maps %s to status %i", (error, status) => {
    expect(errorToHttpStatus(error)).toBe(status);
  });

  it("maps unknown errors to 500", () => {
    expect(errorToHttpStatus(new Error("boom"))).toBe(500);
  });
});

describe("apiErrorHandler canonical envelope", () => {
  it("returns the canonical shape with 400 for client errors", async () => {
    const app = express();
    app.get("/invalid", (_req, _res, next) => {
      next(new ValidationError("invalid field"));
    });
    app.use(apiErrorHandler);

    const response = await request(app).get("/invalid").expect(400);

    expect(response.body.error).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "invalid field",
    });
    expect(response.body.error).toHaveProperty("details");
  });

  it("returns the canonical shape with 500 for server errors", async () => {
    const app = express();
    app.get("/failure", () => {
      throw new Error("boom");
    });
    app.use(apiErrorHandler);

    const response = await request(app).get("/failure").expect(500);

    expect(response.body.error).toMatchObject({
      code: "INTERNAL_ERROR",
      message: "An unexpected server error occurred.",
    });
    expect(response.body.error).toHaveProperty("details");
  });
});

it("returns actionable guidance and warning severity for client errors", async () => {
  vi.stubEnv("LOG_LEVEL", "debug");
  const lines: string[] = [];
  vi.spyOn(console, "log").mockImplementation((value) =>
    lines.push(String(value)),
  );
  const app = express();
  app.get("/invalid", (_req, _res, next) => {
    next(new ValidationError("invalid field"));
  });
  app.use(apiErrorHandler);

  const response = await request(app).get("/invalid").expect(400);

  expect(response.body.error).toMatchObject({
    code: "VALIDATION_ERROR",
    message: "invalid field",
    suggestion: expect.stringContaining(
      "correct the invalid or missing values",
    ),
  });
  expect(JSON.parse(lines[0])).toMatchObject({
    level: "warn",
    severity: "warning",
    status: 400,
  });
});
