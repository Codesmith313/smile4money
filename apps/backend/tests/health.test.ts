import request from 'supertest';
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import healthRouter from '../src/routes/health.js';
import { traceContext } from '../src/middleware/trace-context.js';

describe('/health endpoint', () => {
  let app: express.Express;

  beforeEach(() => {
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
      uptime: expect.any(Number),
      version: '1.2.3',
    });
    expect(response.body.uptime).toBeGreaterThanOrEqual(0);
  });

  it('returns 503 when deep health check fails', async () => {
    process.env.DEEP_HEALTH = 'true';
    process.env.STELLAR_RPC_URL = 'http://localhost:1';
    const response = await request(app).get('/health');
    expect(response.status).toBe(503);
    expect(response.body.error).toMatchObject({
      code: 'SERVICE_UNAVAILABLE',
      message: expect.any(String),
      details: {
        status: 'error',
        uptime: expect.any(Number),
        version: '1.2.3',
        dependencies: { stellar_rpc: 'unreachable' },
      },
      requestId: expect.stringMatching(/^[a-f0-9]{16}$/),
      correlationId: expect.stringMatching(/^[a-f0-9]{32}$/),
      timestamp: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(response.body.error.timestamp))).toBe(false);
    expect(response.headers['x-request-id']).toBe(response.body.error.requestId);
    expect(response.headers['x-correlation-id']).toBe(
      response.body.error.correlationId,
    );
  });
});
