import { afterEach, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import logger from "../src/logger.js";
import { requestLogging } from "../src/middleware/request-logging.js";
import {
  logProviderRequest,
  logProviderResponse,
} from "../src/provider-logging.js";
import { rotateLogs } from "../src/log-rotation.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

it.each([200, 500])(
  "does not expose secrets or linkable identifiers on HTTP %s, even at debug level",
  async (status) => {
    vi.stubEnv("LOG_LEVEL", "debug");
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((value) => {
      lines.push(String(value));
    });
    const app = express();
    app.use(express.json());
    app.use(requestLogging());
    app.post("/wallet/:address", (req, res) => {
      logger[status === 200 ? "info" : "error"](
        {
          ...req.body,
          headers: req.headers,
          error: new Error("token-secret wallet-secret player-secret"),
          nested: { proof: "proof-secret" },
          method: "player-secret",
          count: "token-secret",
          message: "override-secret",
          timestamp: "override-secret",
        },
        "http_request",
      );
      res.sendStatus(status);
    });
    await request(app)
      .post("/wallet/wallet-secret?token=token-secret")
      .set("Authorization", "Bearer token-secret")
      .send({
        username: "player-secret",
        walletAddress: "wallet-secret",
        providerToken: "token-secret",
      });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join("")).not.toMatch(
      /token-secret|wallet-secret|player-secret|proof-secret|override-secret/,
    );
    const summary = lines
      .map((line) => JSON.parse(line))
      .find((line) => line.status);
    expect(summary.status).toBe(status);
    expect(summary.method).toBe("POST");
  },
);

it("masks unapproved event messages and serializes errors without their message", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  logger.error(
    { error: new Error("secret"), arbitrary: { token: "secret" }, status: 500 },
    "secret",
  );
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    message: "log_event",
    status: 500,
    error: { type: "Error" },
  });
  expect(JSON.parse(log.mock.calls[0][0]).error.stack.length).toBeGreaterThan(0);
  expect(log.mock.calls[0][0]).not.toContain("secret");
});

it("redacts PII and sensitive values from error logs", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  logger.error(
    {
      status: 598,
      error_code: "INTERNAL_ERROR",
      email: "person@example.com",
      phone: "+1-555-0100",
      walletAddress: "GPIIADDRESS",
      error: new Error("private diagnostic"),
    },
    "http_error",
  );

  const output = log.mock.calls.map(([line]) => String(line)).join("\n");
  expect(output).not.toMatch(
    /person@example\.com|\+1-555-0100|GPIIADDRESS|private diagnostic/,
  );
  expect(JSON.parse(log.mock.calls[0][0])).toMatchObject({
    message: "http_error",
    status: 598,
  });
  expect(JSON.parse(log.mock.calls[0][0]).error_code).toBeUndefined();
});

it("logs provider requests with a timestamp and sanitized parameters", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  logProviderRequest({
    provider: "openai",
    method: "POST",
    url: "https://api.example.com/v1/chat?token=token-secret",
    headers: { Authorization: "Bearer token-secret" },
    body: {
      model: "gpt-4",
      apiKey: "token-secret",
      walletAddress: "wallet-secret",
      messages: [{ role: "user", content: "hello" }],
    },
  });

  const entry = JSON.parse(log.mock.calls[0][0]);
  expect(entry.message).toBe("provider_request");
  expect(entry.provider).toBe("openai");
  expect(entry.method).toBe("POST");
  expect(entry.timestamp).toEqual(expect.any(String));
  expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
  expect(entry.params).toMatchObject({ model: "gpt-4" });
  expect(log.mock.calls[0][0]).not.toMatch(/token-secret|wallet-secret/);
});

it("logs provider responses with status and sanitized body", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  logProviderResponse({
    provider: "openai",
    method: "POST",
    url: "https://api.example.com/v1/chat",
    status: 200,
    durationMs: 42,
    body: {
      id: "chatcmpl-1",
      token: "token-secret",
      email: "person@example.com",
      choices: [{ message: { content: "hi" } }],
    },
  });

  const entry = JSON.parse(log.mock.calls[0][0]);
  expect(entry.message).toBe("provider_response");
  expect(entry.provider).toBe("openai");
  expect(entry.status).toBe(200);
  expect(entry.durationMs).toBe(42);
  expect(entry.timestamp).toEqual(expect.any(String));
  expect(entry.body).toMatchObject({ id: "chatcmpl-1" });
  expect(log.mock.calls[0][0]).not.toMatch(
    /token-secret|person@example\.com/,
  );
});

it("rotates and archives logs using the configured retention", async () => {
  vi.stubEnv("LOG_RETENTION_DAYS", "7");
  vi.stubEnv("LOG_ARCHIVE_DIR", "/tmp/archive");
  const rotate = vi.fn().mockResolvedValue({ rotated: true });
  const result = await rotateLogs({ rotate });

  expect(rotate).toHaveBeenCalledWith(
    expect.objectContaining({
      retentionDays: 7,
      archiveDir: "/tmp/archive",
    }),
  );
  expect(result.rotated).toBe(true);
});
