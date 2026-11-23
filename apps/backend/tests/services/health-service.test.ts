/**
 * Unit tests for health-service.ts
 *
 * These tests exercise the service function in isolation — no HTTP server,
 * no real Stellar RPC calls. External dependencies are vi.mock'd.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runHealthCheck } from '../../src/services/health-service.js';

// ---------------------------------------------------------------------------
// Mock external dependencies
// ---------------------------------------------------------------------------
vi.mock('../../src/services/stellar.js', () => ({
  checkStellarRpc: vi.fn(),
}));

vi.mock('../../src/services/bottleneck-limiters.js', () => ({
  getAllLimiterStats: vi.fn(() => ({
    lichess: { queued: 0, executing: 0 },
    chessdotcom: { queued: 2, executing: 1 },
  })),
}));

vi.mock('../../src/store/index.js', () => ({
  matchStore: { getSchemaVersion: vi.fn() },
}));

import { checkStellarRpc } from '../../src/services/stellar.js';
import { getAllLimiterStats } from '../../src/services/bottleneck-limiters.js';
import { matchStore } from '../../src/store/index.js';

const mockCheckRpc = vi.mocked(checkStellarRpc);
const mockGetLimiterStats = vi.mocked(getAllLimiterStats);
const mockGetSchemaVersion = vi.mocked(matchStore.getSchemaVersion);

// ---------------------------------------------------------------------------
// runHealthCheck
// ---------------------------------------------------------------------------
describe('runHealthCheck', () => {
  const BASE_OPTIONS = {
    uptimeSeconds: 42,
    version: '1.2.3',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCheckRpc.mockResolvedValue(undefined);
    mockGetSchemaVersion.mockResolvedValue(3);
  });

  it('returns ready with status, uptime, version, and dependency details by default', async () => {
    const result = await runHealthCheck(BASE_OPTIONS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.status).toBe('ok');
      expect(result.payload.ready).toBe(true);
      expect(result.payload.uptime).toBe(42);
      expect(result.payload.version).toBe('1.2.3');
      expect(result.payload.dependencies).toEqual({
        database: { status: 'ok', schemaVersion: 3 },
        stellar_rpc: 'ok',
      });
      expect(result.payload.limiters).toBeUndefined();
    }
    expect(mockCheckRpc).toHaveBeenCalledOnce();
    expect(mockGetSchemaVersion).toHaveBeenCalledOnce();
  });

  it('returns not ready when the RPC check fails', async () => {
    mockCheckRpc.mockRejectedValue(new Error('connection refused'));

    const result = await runHealthCheck(BASE_OPTIONS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.payload.status).toBe('error');
      expect(result.payload.ready).toBe(false);
      expect(result.payload.uptime).toBe(42);
      expect(result.payload.version).toBe('1.2.3');
      expect(result.payload.error).toContain('connection refused');
      expect(result.payload.dependencies).toEqual({
        database: { status: 'ok', schemaVersion: 3 },
        stellar_rpc: 'unreachable',
      });
      expect(result.payload.dependencyErrors).toEqual({
        stellar_rpc: 'connection refused',
      });
    }
  });

  it('reports database and external failures together', async () => {
    mockGetSchemaVersion.mockRejectedValue(new Error('database unavailable'));
    mockCheckRpc.mockRejectedValue('some string error');

    const result = await runHealthCheck(BASE_OPTIONS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.payload.dependencies).toEqual({
        database: { status: 'unreachable', error: 'database unavailable' },
        stellar_rpc: 'unreachable',
      });
      expect(result.payload.dependencyErrors).toEqual({
        database: 'database unavailable',
        stellar_rpc: 'some string error',
      });
      expect(result.payload.error).toContain('database: database unavailable');
      expect(result.payload.error).toContain('stellar_rpc: some string error');
    }
  });

  it('includes limiter stats when includeLimiters is true', async () => {
    const result = await runHealthCheck({
      ...BASE_OPTIONS,
      includeLimiters: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.limiters).toBeDefined();
      expect(mockGetLimiterStats).toHaveBeenCalledOnce();
    }
  });

  it('does not include limiter stats when includeLimiters is false', async () => {
    const result = await runHealthCheck({
      ...BASE_OPTIONS,
      includeLimiters: false,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.limiters).toBeUndefined();
    }
    expect(mockGetLimiterStats).not.toHaveBeenCalled();
  });

  it('propagates the exact version string passed in', async () => {
    const result = await runHealthCheck({
      uptimeSeconds: 0,
      version: 'unknown',
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.version).toBe('unknown');
    }
  });

  it('includes limiter stats alongside readiness checks', async () => {
    const result = await runHealthCheck({
      ...BASE_OPTIONS,
      includeLimiters: true,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.limiters).toBeDefined();
    }
    expect(mockCheckRpc).toHaveBeenCalledOnce();
    expect(mockGetLimiterStats).toHaveBeenCalledOnce();
  });
});
