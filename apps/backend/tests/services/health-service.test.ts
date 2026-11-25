/**
 * Unit tests for health-service.ts
 *
 * These tests exercise the service function in isolation — no HTTP server,
 * no real Stellar RPC calls. External dependencies are vi.mock'd.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  runHealthCheck,
  recordProviderResult,
  getProviderHealth,
  getAllProviderHealth,
  resetProviderHealth,
} from '../../src/services/health-service.js';

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

// ---------------------------------------------------------------------------
// Provider health monitoring
// ---------------------------------------------------------------------------
describe('provider health monitoring', () => {
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderHealth();
  });

  it('records successful responses per provider', () => {
    recordProviderResult('lichess', { success: true, responseTimeMs: 120, at: NOW });
    recordProviderResult('lichess', { success: true, responseTimeMs: 180, at: NOW + 1000 });

    const health = getProviderHealth('lichess');
    expect(health).toBeDefined();
    expect(health!.provider).toBe('lichess');
    expect(health!.totalRequests).toBe(2);
    expect(health!.successCount).toBe(2);
    expect(health!.failureCount).toBe(0);
    expect(health!.uptime).toBe(1);
    expect(health!.degraded).toBe(false);
  });

  it('records failures and computes uptime over the window', () => {
    recordProviderResult('chessdotcom', { success: true, responseTimeMs: 100, at: NOW });
    recordProviderResult('chessdotcom', { success: false, responseTimeMs: 5000, at: NOW + 1000 });
    recordProviderResult('chessdotcom', { success: true, responseTimeMs: 150, at: NOW + 2000 });
    recordProviderResult('chessdotcom', { success: false, responseTimeMs: 4000, at: NOW + 3000 });

    const health = getProviderHealth('chessdotcom');
    expect(health!.totalRequests).toBe(4);
    expect(health!.successCount).toBe(2);
    expect(health!.failureCount).toBe(2);
    expect(health!.uptime).toBeCloseTo(0.5, 5);
  });

  it('computes p50 and p95 response times', () => {
    const latencies = [100, 110, 120, 130, 140, 150, 160, 170, 180, 200];
    latencies.forEach((ms, i) => {
      recordProviderResult('lichess', { success: true, responseTimeMs: ms, at: NOW + i });
    });

    const health = getProviderHealth('lichess');
    expect(health!.p50ResponseTimeMs).toBeGreaterThanOrEqual(130);
    expect(health!.p50ResponseTimeMs).toBeLessThanOrEqual(150);
    expect(health!.p95ResponseTimeMs).toBeGreaterThanOrEqual(180);
    expect(health!.p95ResponseTimeMs).toBeLessThanOrEqual(200);
    expect(health!.avgResponseTimeMs).toBeCloseTo(146, 0);
  });

  it('reports degradation when uptime drops below threshold', () => {
    for (let i = 0; i < 10; i++) {
      recordProviderResult('lichess', {
        success: i < 5,
        responseTimeMs: 100,
        at: NOW + i,
      });
    }

    const health = getProviderHealth('lichess');
    expect(health!.uptime).toBeCloseTo(0.5, 5);
    expect(health!.degraded).toBe(true);
    expect(health!.degradationReasons).toContain('uptime');
  });

  it('reports degradation when p95 latency exceeds threshold (slow responses)', () => {
    for (let i = 0; i < 20; i++) {
      recordProviderResult('chessdotcom', {
        success: true,
        responseTimeMs: i < 18 ? 100 : 10_000,
        at: NOW + i,
      });
    }

    const health = getProviderHealth('chessdotcom');
    expect(health!.degraded).toBe(true);
    expect(health!.degradationReasons).toContain('latency');
  });

  it('emits an alert when a provider becomes degraded', () => {
    const onAlert = vi.fn();
    for (let i = 0; i < 10; i++) {
      recordProviderResult(
        'lichess',
        { success: i < 3, responseTimeMs: 100, at: NOW + i },
        { onAlert },
      );
    }

    expect(onAlert).toHaveBeenCalled();
    const alert = onAlert.mock.calls.at(-1)![0];
    expect(alert.provider).toBe('lichess');
    expect(alert.reasons).toContain('uptime');
  });

  it('does not emit an alert while a provider is healthy', () => {
    const onAlert = vi.fn();
    for (let i = 0; i < 10; i++) {
      recordProviderResult(
        'lichess',
        { success: true, responseTimeMs: 100, at: NOW + i },
        { onAlert },
      );
    }

    expect(onAlert).not.toHaveBeenCalled();
  });

  it('simulates an outage and recovers uptime after healthy responses', () => {
    for (let i = 0; i < 5; i++) {
      recordProviderResult('lichess', { success: false, responseTimeMs: 0, at: NOW + i });
    }
    expect(getProviderHealth('lichess')!.uptime).toBe(0);
    expect(getProviderHealth('lichess')!.degraded).toBe(true);

    for (let i = 0; i < 5; i++) {
      recordProviderResult('lichess', {
        success: true,
        responseTimeMs: 100,
        at: NOW + 100 + i,
      });
    }
    const health = getProviderHealth('lichess')!;
    expect(health.uptime).toBeCloseTo(0.5, 5);
  });

  it('returns health for all tracked providers', () => {
    recordProviderResult('lichess', { success: true, responseTimeMs: 100, at: NOW });
    recordProviderResult('chessdotcom', { success: false, responseTimeMs: 500, at: NOW });

    const all = getAllProviderHealth();
    expect(Object.keys(all).sort()).toEqual(['chessdotcom', 'lichess']);
    expect(all.lichess.totalRequests).toBe(1);
    expect(all.chessdotcom.failureCount).toBe(1);
  });

  it('returns undefined for an unknown provider', () => {
    expect(getProviderHealth('unknown')).toBeUndefined();
  });
});
