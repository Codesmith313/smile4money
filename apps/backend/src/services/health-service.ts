/**
 * Health Service
 *
 * Contains the business logic for the health-check endpoint. The route
 * handler in routes/health.ts delegates here so the logic can be tested
 * independently of HTTP concerns.
 */

import { checkStellarRpc } from './stellar.js';
import { getAllLimiterStats } from './bottleneck-limiters.js';
import {
  getSettlementAgeMonitor,
  type SettlementSnapshot,
} from './settlement-age-monitor.js';
import { matchStore } from '../store/index.js';

interface QueueMetricsSnapshot {
  depth: number;
  oldestEntryAgeMs: number;
  processed: number;
  failed: number;
  successRate: number;
  updatedAt: number;
}

interface DatabaseIntegrityStatus {
  database: string;
  timestamp: number;
  ok: boolean;
  details: string;
}

export interface HealthCheckOptions {
  /** When true, appends rate-limiter statistics to the response payload. */
  includeLimiters?: boolean;
  /** When true, appends settlement age percentiles and active alerts to the response payload. */
  includeSettlement?: boolean;
  /** When true, appends queue monitoring metrics to the response payload. */
  includeQueue?: boolean;
  /** When true, appends the latest recorded integrity checks to the response. */
  includeDatabase?: boolean;
  /** When true, appends per-provider health metrics to the response payload. */
  includeProviders?: boolean;
  /** Uptime in seconds (passed in from the route so the timer origin is preserved). */
  uptimeSeconds: number;
  /** Application version string. */
  version: string;
}

export interface HealthDependency {
  status: 'ok' | 'unreachable';
  error?: string;
  schemaVersion?: number;
}

/**
 * A single recorded provider request outcome.
 */
interface ProviderSample {
  timestamp: number;
  success: boolean;
  latencyMs: number;
}

/**
 * Aggregated health metrics for a single provider over the rolling window.
 */
export interface ProviderHealthMetrics {
  provider: string;
  /** Total samples recorded within the rolling window. */
  samples: number;
  /** Number of successful samples within the rolling window. */
  successes: number;
  /** Number of failed samples within the rolling window. */
  failures: number;
  /** Uptime as a fraction (0..1) of successful samples within the window. */
  uptime: number;
  /** Error rate as a fraction (0..1) of failed samples within the window. */
  errorRate: number;
  /** Median response time in milliseconds within the window. */
  p50ResponseMs: number;
  /** 95th percentile response time in milliseconds within the window. */
  p95ResponseMs: number;
  /** Whether the provider is currently considered degraded. */
  degraded: boolean;
  /** Reasons the provider is considered degraded (empty when healthy). */
  degradationReasons: string[];
  /** Timestamp of the most recent sample, or null when no samples exist. */
  lastSampleAt: number | null;
}

interface ProviderHealthPayload {
  windowMs: number;
  errorRateThreshold: number;
  latencyMsThreshold: number;
  providers: ProviderHealthMetrics[];
}

interface HealthPayload {
  uptime: number;
  version: string;
  ready: boolean;
  dependencies: {
    database: HealthDependency;
    stellar_rpc: 'ok' | 'unreachable';
  };
  dependencyErrors?: { database?: string; stellar_rpc?: string };
  database?: {
    integrity: DatabaseIntegrityStatus[];
    schemaVersion?: number;
  };
  limiters?: ReturnType<typeof getAllLimiterStats>;
  settlement?: SettlementSnapshot | null;
  queue?: QueueMetricsSnapshot | null;
  providers?: ProviderHealthPayload;
}

export interface HealthOk {
  ok: true;
  payload: HealthPayload & { status: 'ok'; ready: true };
}

export interface HealthError {
  ok: false;
  payload: HealthPayload & { status: 'error'; ready: false; error: string };
}

export type HealthCheckResult = HealthOk | HealthError;

/* -------------------------------------------------------------------------- */
/*                        Provider health monitoring                          */
/* -------------------------------------------------------------------------- */

const DEFAULT_PROVIDER_HEALTH_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
const DEFAULT_PROVIDER_HEALTH_ERROR_RATE_THRESHOLD = 0.25; // 25%
const DEFAULT_PROVIDER_HEALTH_LATENCY_MS_THRESHOLD = 2000; // 2s

function readPositiveNumberEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function readFractionEnv(name: string, fallback: number): number {
  const value = readPositiveNumberEnv(name, fallback);
  return value > 1 ? 1 : value;
}

function getProviderHealthWindowMs(): number {
  return readPositiveNumberEnv(
    'PROVIDER_HEALTH_WINDOW_MS',
    DEFAULT_PROVIDER_HEALTH_WINDOW_MS,
  );
}

function getProviderHealthErrorRateThreshold(): number {
  return readFractionEnv(
    'PROVIDER_HEALTH_ERROR_RATE_THRESHOLD',
    DEFAULT_PROVIDER_HEALTH_ERROR_RATE_THRESHOLD,
  );
}

function getProviderHealthLatencyMsThreshold(): number {
  return readPositiveNumberEnv(
    'PROVIDER_HEALTH_LATENCY_MS_THRESHOLD',
    DEFAULT_PROVIDER_HEALTH_LATENCY_MS_THRESHOLD,
  );
}

/** In-memory rolling sample store keyed by provider name. */
const providerSamples = new Map<string, ProviderSample[]>();

/** Tracks the last emitted degradation state per provider to avoid log spam. */
const providerDegradedState = new Map<string, boolean>();

function pruneSamples(samples: ProviderSample[], cutoff: number): void {
  let firstValid = 0;
  while (firstValid < samples.length && samples[firstValid].timestamp < cutoff) {
    firstValid += 1;
  }
  if (firstValid > 0) {
    samples.splice(0, firstValid);
  }
}

function computePercentile(sorted: number[], percentile: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0];
  }
  const rank = (percentile / 100) * (sorted.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = rank - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

/**
 * Record the outcome of a provider request. Call this from provider fetchers
 * after each attempt so uptime and latency can be tracked.
 */
export function recordProviderSample(
  provider: string,
  success: boolean,
  latencyMs: number,
  timestamp: number = Date.now(),
): void {
  if (!provider) {
    return;
  }
  const windowMs = getProviderHealthWindowMs();
  const cutoff = timestamp - windowMs;
  let samples = providerSamples.get(provider);
  if (!samples) {
    samples = [];
    providerSamples.set(provider, samples);
  }
  samples.push({
    timestamp,
    success,
    latencyMs: Number.isFinite(latencyMs) && latencyMs >= 0 ? latencyMs : 0,
  });
  pruneSamples(samples, cutoff);
}

/**
 * Convenience wrapper that times an async provider call and records the
 * outcome. Re-throws the original error after recording so callers keep
 * their existing error handling.
 */
export async function trackProviderCall<T>(
  provider: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    const result = await fn();
    recordProviderSample(provider, true, Date.now() - start);
    return result;
  } catch (error) {
    recordProviderSample(provider, false, Date.now() - start);
    throw error;
  }
}

function computeProviderMetrics(
  provider: string,
  samples: ProviderSample[],
  now: number,
): ProviderHealthMetrics {
  const windowMs = getProviderHealthWindowMs();
  const cutoff = now - windowMs;
  pruneSamples(samples, cutoff);

  const errorRateThreshold = getProviderHealthErrorRateThreshold();
  const latencyMsThreshold = getProviderHealthLatencyMsThreshold();

  const total = samples.length;
  let successes = 0;
  const latencies: number[] = [];
  let lastSampleAt: number | null = null;

  for (const sample of samples) {
    if (sample.success) {
      successes += 1;
    }
    latencies.push(sample.latencyMs);
    if (lastSampleAt === null || sample.timestamp > lastSampleAt) {
      lastSampleAt = sample.timestamp;
    }
  }

  const failures = total - successes;
  const uptime = total > 0 ? successes / total : 1;
  const errorRate = total > 0 ? failures / total : 0;

  latencies.sort((a, b) => a - b);
  const p50ResponseMs = computePercentile(latencies, 50);
  const p95ResponseMs = computePercentile(latencies, 95);

  const degradationReasons: string[] = [];
  if (total > 0 && errorRate > errorRateThreshold) {
    degradationReasons.push(
      `error rate ${(errorRate * 100).toFixed(1)}% exceeds threshold ${(
        errorRateThreshold * 100
      ).toFixed(1)}%`,
    );
  }
  if (total > 0 && p95ResponseMs > latencyMsThreshold) {
    degradationReasons.push(
      `p95 response time ${Math.round(p95ResponseMs)}ms exceeds threshold ${latencyMsThreshold}ms`,
    );
  }

  return {
    provider,
    samples: total,
    successes,
    failures,
    uptime,
    errorRate,
    p50ResponseMs,
    p95ResponseMs,
    degraded: degradationReasons.length > 0,
    degradationReasons,
    lastSampleAt,
  };
}

function emitDegradationAlert(metrics: ProviderHealthMetrics): void {
  const previouslyDegraded = providerDegradedState.get(metrics.provider) ?? false;
  if (metrics.degraded && !previouslyDegraded) {
    providerDegradedState.set(metrics.provider, true);
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'provider_degraded',
        provider: metrics.provider,
        reasons: metrics.degradationReasons,
        uptime: metrics.uptime,
        errorRate: metrics.errorRate,
        p50ResponseMs: metrics.p50ResponseMs,
        p95ResponseMs: metrics.p95ResponseMs,
        samples: metrics.samples,
        timestamp: Date.now(),
      }),
    );
  } else if (!metrics.degraded && previouslyDegraded) {
    providerDegradedState.set(metrics.provider, false);
    // eslint-disable-next-line no-console
    console.info(
      JSON.stringify({
        level: 'info',
        event: 'provider_recovered',
        provider: metrics.provider,
        uptime: metrics.uptime,
        errorRate: metrics.errorRate,
        p50ResponseMs: metrics.p50ResponseMs,
        p95ResponseMs: metrics.p95ResponseMs,
        samples: metrics.samples,
        timestamp: Date.now(),
      }),
    );
  }
}

/**
 * Compute current health metrics for every tracked provider. Emits
 * degradation/recovery alerts as a side effect when state transitions occur.
 */
export function getProviderHealth(): ProviderHealthPayload {
  const now = Date.now();
  const providers: ProviderHealthMetrics[] = [];
  for (const [provider, samples] of providerSamples.entries()) {
    const metrics = computeProviderMetrics(provider, samples, now);
    emitDegradationAlert(metrics);
    providers.push(metrics);
  }
  providers.sort((a, b) => a.provider.localeCompare(b.provider));
  return {
    windowMs: getProviderHealthWindowMs(),
    errorRateThreshold: getProviderHealthErrorRateThreshold(),
    latencyMsThreshold: getProviderHealthLatencyMsThreshold(),
    providers,
  };
}

/**
 * Reset all recorded provider health data. Intended for tests.
 */
export function resetProviderHealth(): void {
  providerSamples.clear();
  providerDegradedState.clear();
}

/* -------------------------------------------------------------------------- */
/*                              Health check                                  */
/* -------------------------------------------------------------------------- */

/**
 * Check every dependency required to serve requests. A failing database or
 * Stellar RPC probe marks the service not ready while retaining the status
 * and error for both dependencies in the response.
 */
export async function runHealthCheck(
  options: HealthCheckOptions,
): Promise<HealthCheckResult> {
  const [database, stellarRpc] = await Promise.all([
    matchStore
      .getSchemaVersion()
      .then(
        (schemaVersion): HealthDependency => ({ status: 'ok', schemaVersion }),
      )
      .catch(
        (error): HealthDependency => ({
          status: 'unreachable',
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
    checkStellarRpc()
      .then((): HealthDependency => ({ status: 'ok' }))
      .catch(
        (error): HealthDependency => ({
          status: 'unreachable',
          error: error instanceof Error ? error.message : String(error),
        }),
      ),
  ]);
  const failures = [
    database.status === 'unreachable'
      ? `database: ${database.error}`
      : undefined,
    stellarRpc.status === 'unreachable'
      ? `stellar_rpc: ${stellarRpc.error}`
      : undefined,
  ].filter((failure): failure is string => failure !== undefined);
  const payload: HealthPayload = {
    uptime: options.uptimeSeconds,
    version: options.version,
    ready: failures.length === 0,
    dependencies: {
      database,
      stellar_rpc: stellarRpc.status,
    },
    ...(database.error || stellarRpc.error
      ? {
          dependencyErrors: {
            ...(database.error ? { database: database.error } : {}),
            ...(stellarRpc.error ? { stellar_rpc: stellarRpc.error } : {}),
          },
        }
      : {}),
  };

  if (options.includeLimiters) {
    payload.limiters = getAllLimiterStats();
  }
  if (options.includeSettlement) {
    payload.settlement = getSettlementAgeMonitor()?.getSnapshot() ?? null;
  }
  if (options.includeQueue) {
    const { getQueueMetrics } = await import('../queue.js');
    payload.queue = getQueueMetrics();
  }
  if (options.includeDatabase) {
    const { getLatestIntegrityStatus } =
      await import('../store/db-maintenance.js');
    payload.database = {
      integrity: getLatestIntegrityStatus(),
      schemaVersion: database.schemaVersion,
    };
  }
  if (options.includeProviders) {
    payload.providers = getProviderHealth();
  }

  if (failures.length > 0) {
    return {
      ok: false,
      payload: {
        ...payload,
        status: 'error',
        ready: false,
        error: failures.join('; '),
      },
    };
  }
  return { ok: true, payload: { ...payload, status: 'ok', ready: true } };
}