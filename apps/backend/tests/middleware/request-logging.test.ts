/**
 * Tests for the request-logging middleware (#1722):
 * - Request bodies must never appear in INFO-level output.
 * - At DEBUG level, sensitive fields are redacted before the body is logged.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { requestLogging } from '../../src/middleware/request-logging.js';
import { sanitizeForLogging } from '../../src/utils/log-sanitizer.js';

function captureConsoleLog(): string[] {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((arg: unknown) => {
    lines.push(String(arg));
  });
  return lines;
}

function parsedLogs(lines: string[]): any[] {
  return lines
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appWithLogging() {
  const app = express();
  app.use(express.json());
  app.use(requestLogging());
  app.post('/echo', (req, res) => {
    res.status(200).json({ ok: true });
  });
  return app;
}

describe('requestLogging middleware', () => {
  const originalLogLevel = process.env.LOG_LEVEL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('at INFO level (production default), no sensitive fields or body appear anywhere in the output', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOG_LEVEL;
    const lines = captureConsoleLog();

    await request(appWithLogging()).post('/echo').send({
      player1: 'GSECRETADDRESS',
      username: 'alice',
      gameId: 'game-123',
    });

    const logs = parsedLogs(lines);
    expect(logs.length).toBeGreaterThan(0);

    for (const entry of logs) {
      expect(entry.body).toBeUndefined();
      expect(JSON.stringify(entry)).not.toContain('GSECRETADDRESS');
      expect(JSON.stringify(entry)).not.toContain('alice');
    }

    // The INFO request-summary line must still be present.
    const summary = logs.find((l) => l.message === 'http_request');
    expect(summary).toBeDefined();
    expect(summary.method).toBe('POST');
    expect(summary.status).toBe(200);
  });

  it('at DEBUG level, request bodies are never emitted', async () => {
    process.env.LOG_LEVEL = 'debug';
    const lines = captureConsoleLog();
    await request(appWithLogging()).post('/echo').send({
      player1: 'GSECRETADDRESS',
      username: 'alice',
      gameId: 'game-123',
    });
    expect(parsedLogs(lines).find((l) => l.body)).toBeUndefined();
    expect(lines.join('')).not.toMatch(/GSECRETADDRESS|alice|game-123/);
  });

  it('does not emit a body line at all when DEBUG is not enabled', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOG_LEVEL;
    const lines = captureConsoleLog();

    await request(appWithLogging())
      .post('/echo')
      .send({ player1: 'GSECRETADDRESS' });

    const logs = parsedLogs(lines);
    expect(logs.find((l) => l.message === 'http_request_body')).toBeUndefined();
  });
});

describe('provider request logging', () => {
  const originalLogLevel = process.env.LOG_LEVEL;
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = originalLogLevel;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  });

  it('sanitizeForLogging redacts sensitive provider fields', () => {
    const sanitized = sanitizeForLogging({
      apiKey: 'sk-live-SECRET',
      authorization: 'Bearer SECRET',
      player1: 'GSECRETADDRESS',
      username: 'alice',
      gameId: 'game-123',
      nested: { secret: 'SECRET', value: 42 },
    }) as Record<string, any>;

    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain('sk-live-SECRET');
    expect(serialized).not.toContain('GSECRETADDRESS');
    expect(serialized).not.toContain('alice');
    expect(serialized).not.toContain('SECRET');
    expect(sanitized.gameId).toBe('game-123');
    expect(sanitized.nested.value).toBe(42);
  });

  it('provider request logs never leak secrets at INFO level', async () => {
    process.env.NODE_ENV = 'production';
    delete process.env.LOG_LEVEL;
    const lines = captureConsoleLog();

    await request(appWithLogging())
      .post('/echo')
      .set('Authorization', 'Bearer SECRET-TOKEN')
      .send({
        apiKey: 'sk-live-SECRET',
        player1: 'GSECRETADDRESS',
        username: 'alice',
      });

    const output = lines.join('');
    expect(output).not.toMatch(/SECRET-TOKEN|sk-live-SECRET|GSECRETADDRESS|alice/);
  });

  it('emits sanitized bodies only at DEBUG level', async () => {
    process.env.LOG_LEVEL = 'debug';
    const lines = captureConsoleLog();

    await request(appWithLogging())
      .post('/echo')
      .send({ apiKey: 'sk-live-SECRET', gameId: 'game-123' });

    const output = lines.join('');
    expect(output).not.toContain('sk-live-SECRET');
    expect(output).not.toContain('SECRET-TOKEN');
  });
});
