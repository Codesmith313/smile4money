import { logger } from '../utils/logger';

export type OracleOperationType =
  | 'submit_result'
  | 'fetch_request'
  | 'validate_result'
  | 'consensus'
  | 'other';

export interface OracleMetricsConfig {
  /** Size of the per-operation latency ring buffer. */
  bufferSize: number;
  /** Rolling window (ms) used for submissions/hour calculation. */
  windowMs: number;
  /** Minimum success rate (0..1) before degradation alert fires. */
  minSuccessRate: number;
  /** p95 latency threshold (ms) before degradation alert fires. */
  maxP95LatencyMs: number;
  /** Minimum number of samples before thresholds are evaluated. */
  minSamplesForAlert: number;
}

export interface OperationSnapshot {
  operation: OracleOperationType;
  total: number;
  success: number;
  failure: number;
  successRate: number;
  submissionsPerHour: number;
  latency: {
    count: number;
    min: number | null;
    max: number | null;
    avg: number | null;
    p50: number | null;
    p95: number | null;
    p99: number | null;
  };
}

export interface OracleMetricsSnapshot {
  generatedAt: string;
  windowMs: number;
  totals: {
    total: number;
    success: number;
    failure: number;
    successRate: number;
    submissionsPerHour: number;
  };
  operations: OperationSnapshot[];
}

export interface ThresholdViolation {
  operation: OracleOperationType;
  reason: 'success_rate' | 'latency';
  actual: number;
  threshold: number;
}

interface LatencySample {
  durationMs: number;
  ok: boolean;
  timestamp: number;
}

interface OperationState {
  total: number;
  success: number;
  failure: number;
  samples: LatencySample[];
  sampleIndex: number;
  sampleCount: number;
}

const DEFAULT_CONFIG: OracleMetricsConfig = {
  bufferSize: 1000,
  windowMs: 60 * 60 * 1000,
  minSuccessRate: 0.95,
  maxP95LatencyMs: 5000,
  minSamplesForAlert: 20,
};

const OPERATION_TYPES: OracleOperationType[] = [
  'submit_result',
  'fetch_request',
  'validate_result',
  'consensus',
  'other',
];

function createOperationState(): OperationState {
  return {
    total: 0,
    success: 0,
    failure: 0,
    samples: [],
    sampleIndex: 0,
    sampleCount: 0,
  };
}

/**
 * Nearest-rank percentile over a sorted ascending array.
 * Returns null for an empty array.
 */
function nearestRank(sorted: number[], percentile: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((percentile / 100) * sorted.length);
  const index = Math.min(Math.max(rank - 1, 0), sorted.length - 1);
  return sorted[index];
}

export interface OracleMetrics {
  record(operation: OracleOperationType, durationMs: number, ok: boolean): void;
  snapshot(): OracleMetricsSnapshot;
  checkThresholds(): ThresholdViolation[];
  reset(): void;
  getConfig(): OracleMetricsConfig;
}

export function createOracleMetrics(
  config: Partial<OracleMetricsConfig> = {},
): OracleMetrics {
  const cfg: OracleMetricsConfig = { ...DEFAULT_CONFIG, ...config };
  const bufferSize = Math.max(1, Math.floor(cfg.bufferSize));

  const states = new Map<OracleOperationType, OperationState>();
  for (const op of OPERATION_TYPES) {
    states.set(op, createOperationState());
  }

  function getState(operation: OracleOperationType): OperationState {
    let state = states.get(operation);
    if (!state) {
      state = createOperationState();
      states.set(operation, state);
    }
    return state;
  }

  function record(
    operation: OracleOperationType,
    durationMs: number,
    ok: boolean,
  ): void {
    const state = getState(operation);
    const duration = Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : 0;
    const now = Date.now();

    state.total += 1;
    if (ok) {
      state.success += 1;
    } else {
      state.failure += 1;
    }

    const sample: LatencySample = { durationMs: duration, ok, timestamp: now };

    if (state.samples.length < bufferSize) {
      state.samples.push(sample);
    } else {
      state.samples[state.sampleIndex] = sample;
    }
    state.sampleIndex = (state.sampleIndex + 1) % bufferSize;
    state.sampleCount = Math.min(state.sampleCount + 1, bufferSize);
  }

  function getSamples(state: OperationState): LatencySample[] {
    if (state.samples.length < bufferSize) {
      return state.samples;
    }
    // Ring buffer is full; return in chronological order.
    const ordered: LatencySample[] = [];
    for (let i = 0; i < state.samples.length; i += 1) {
      ordered.push(state.samples[(state.sampleIndex + i) % state.samples.length]);
    }
    return ordered;
  }

  function buildOperationSnapshot(
    operation: OracleOperationType,
    state: OperationState,
    now: number,
  ): OperationSnapshot {
    const samples = getSamples(state);
    const windowStart = now - cfg.windowMs;

    let windowCount = 0;
    const durations: number[] = [];
    let min: number | null = null;
    let max: number | null = null;
    let sum = 0;

    for (const sample of samples) {
      if (sample.timestamp >= windowStart) {
        windowCount += 1;
      }
      durations.push(sample.durationMs);
      if (min === null || sample.durationMs < min) min = sample.durationMs;
      if (max === null || sample.durationMs > max) max = sample.durationMs;
      sum += sample.durationMs;
    }

    durations.sort((a, b) => a - b);

    const successRate = state.total > 0 ? state.success / state.total : 0;
    const submissionsPerHour =
      cfg.windowMs > 0 ? (windowCount / cfg.windowMs) * 60 * 60 * 1000 : 0;

    return {
      operation,
      total: state.total,
      success: state.success,
      failure: state.failure,
      successRate,
      submissionsPerHour,
      latency: {
        count: durations.length,
        min,
        max,
        avg: durations.length > 0 ? sum / durations.length : null,
        p50: nearestRank(durations, 50),
        p95: nearestRank(durations, 95),
        p99: nearestRank(durations, 99),
      },
    };
  }

  function snapshot(): OracleMetricsSnapshot {
    const now = Date.now();
    const operations: OperationSnapshot[] = [];

    let total = 0;
    let success = 0;
    let failure = 0;
    let totalSubmissionsPerHour = 0;

    for (const op of OPERATION_TYPES) {
      const state = getState(op);
      const opSnapshot = buildOperationSnapshot(op, state, now);
      operations.push(opSnapshot);
      total += opSnapshot.total;
      success += opSnapshot.success;
      failure += opSnapshot.failure;
      totalSubmissionsPerHour += opSnapshot.submissionsPerHour;
    }

    return {
      generatedAt: new Date(now).toISOString(),
      windowMs: cfg.windowMs,
      totals: {
        total,
        success,
        failure,
        successRate: total > 0 ? success / total : 0,
        submissionsPerHour: totalSubmissionsPerHour,
      },
      operations,
    };
  }

  function checkThresholds(): ThresholdViolation[] {
    const violations: ThresholdViolation[] = [];
    const current = snapshot();

    for (const opSnapshot of current.operations) {
      if (opSnapshot.total < cfg.minSamplesForAlert) {
        continue;
      }

      if (opSnapshot.successRate < cfg.minSuccessRate) {
        violations.push({
          operation: opSnapshot.operation,
          reason: 'success_rate',
          actual: opSnapshot.successRate,
          threshold: cfg.minSuccessRate,
        });
      }

      const p95 = opSnapshot.latency.p95;
      if (p95 !== null && p95 > cfg.maxP95LatencyMs) {
        violations.push({
          operation: opSnapshot.operation,
          reason: 'latency',
          actual: p95,
          threshold: cfg.maxP95LatencyMs,
        });
      }
    }

    if (violations.length > 0) {
      logger.warn('oracle_performance_degraded', {
        violations,
        thresholds: {
          minSuccessRate: cfg.minSuccessRate,
          maxP95LatencyMs: cfg.maxP95LatencyMs,
        },
        snapshot: current,
      });
    }

    return violations;
  }

  function reset(): void {
    for (const op of OPERATION_TYPES) {
      states.set(op, createOperationState());
    }
  }

  function getConfig(): OracleMetricsConfig {
    return { ...cfg };
  }

  return {
    record,
    snapshot,
    checkThresholds,
    reset,
    getConfig,
  };
}

/**
 * Singleton instance shared by services and routes.
 */
export const oracleMetrics = createOracleMetrics();

export default oracleMetrics;