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
