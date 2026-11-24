import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import healthRouter from '../src/routes/health.js';
import { traceContext } from '../src/middleware/trace-context.js';
import { runHealthCheck } from '../src/services/health-service.js';

vi.mock('../src/services/health-service.js', () => ({
  runHealthCheck: vi.fn(),
}));

describe('/health endpoint', () => {
  let app: express.Express;

  beforeEach(() => {
    vi.mocked(runHealthCheck).mockReset();
    vi.mocked(runHealthCheck).mockResolvedValue({
      ok: true,
      payload: {
        status: 'ok',
        ready: true,
        uptime: 42,
        version: '1.2.3',
        dependencies: {
          database: { status: 'ok', schemaVersion: 3 },
          stellar_rpc: 'ok',
        },
      },
    });
    app = express();
    app.use(traceContext());
    app.use('/health', healthRouter);
  });

  it('returns 200 with status, uptime, and version', async () => {
    process.env.BACKEND_VERSION = '1.2.3';
    const response = await request(app).get('/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      ready: true,
      uptime: 42,
      version: '1.2.3',
      dependencies: {
        database: { status: 'ok', schemaVersion: 3 },
        stellar_rpc: 'ok',
      },
    });
    expect(runHealthCheck).toHaveBeenCalledWith(
      expect.objectContaining({
        uptimeSeconds: expect.any(Number),
        version: '1.2.3',
      }),
    );
  });

  it('returns 503 when a dependency is unavailable', async () => {
    vi.mocked(runHealthCheck).mockResolvedValue({
      ok: false,
      payload: {
        status: 'error',
        ready: false,
        uptime: 42,
        version: '1.2.3',
        error: 'stellar_rpc: connection refused',
        dependencies: {
          database: { status: 'ok', schemaVersion: 3 },
          stellar_rpc: 'unreachable',
        },
        dependencyErrors: { stellar_rpc: 'connection refused' },
      },
    });
    const response = await request(app).get('/health');
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.any(String),
      details: {
        status: 'error',
        ready: false,
        uptime: expect.any(Number),
        version: '1.2.3',
        dependencies: {
          database: { status: 'ok', schemaVersion: 3 },
          stellar_rpc: 'unreachable',
        },
        dependencyErrors: { stellar_rpc: 'connection refused' },
      },
      requestId: expect.stringMatching(/^[a-f0-9]{16}$/),
      correlationId: expect.stringMatching(/^[a-f0-9]{32}$/),
      timestamp: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(response.body.error.timestamp))).toBe(false);
    expect(response.headers['x-request-id']).toBe(
      response.body.error.requestId,
    );
    expect(response.headers['x-correlation-id']).toBe(
      response.body.error.correlationId,
    );
  });
});
