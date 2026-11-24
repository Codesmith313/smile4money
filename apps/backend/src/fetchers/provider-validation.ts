import axios from 'axios';
import logger from '../logger.js';
import { traceHeaders } from '../tracing/trace-context.js';

export type ProviderFailureKind =
  | 'unavailable'
  | 'invalid_data'
  | 'access_denied'
  | 'schema_changed';
export class ProviderFetchError extends Error {
  readonly policy: 'retry' | 'review';
  constructor(
    readonly kind: ProviderFailureKind,
    message: string,
  ) {
    super(message);
    this.name = 'ProviderFetchError';
    this.policy = kind === 'unavailable' ? 'retry' : 'review';
  }
}

export class ProviderSchemaError extends ProviderFetchError {
  constructor(
    readonly provider: string,
    readonly field: string,
  ) {
    super(
      'schema_changed',
      `${provider} response schema changed (missing/invalid ${field}); operator review required`,
    );
    this.name = 'ProviderSchemaError';
  }
}

export interface LichessGameResponse {
  id: string;
  status: string;
  players: {
    white: { user?: { name?: string } };
    black: { user?: { name?: string } };
  };
  [key: string]: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Detects axios timeout errors. Timeouts are transient and safe to retry with
 * exponential backoff. Never inspects config/headers to avoid leaking secrets.
 */
export function isTimeoutError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;
  return error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
}

export function validateLichessGameSchema(
  data: unknown,
): asserts data is LichessGameResponse {
  const provider = 'lichess';
  if (!isRecord(data)) {
    throw new ProviderSchemaError(provider, 'root');
  }
  if (typeof data.id !== 'string' || data.id.length === 0) {
    throw new ProviderSchemaError(provider, 'id');
  }
  if (typeof data.status !== 'string' || data.status.length === 0) {
    throw new ProviderSchemaError(provider, 'status');
  }
  if (!isRecord(data.players)) {
    throw new ProviderSchemaError(provider, 'players');
  }
  if (!isRecord(data.players.white)) {
    throw new ProviderSchemaError(provider, 'players.white');
  }
  if (!isRecord(data.players.black)) {
    throw new ProviderSchemaError(provider, 'players.black');
  }
}

/** Never include payloads, player names, URLs, tokens or unknown provider labels. */
export function quarantine(provider: string, reason: string): never {
  logger.warn({ provider, reason }, 'provider_evidence_quarantined');
  throw new ProviderFetchError(
    'invalid_data',
    `${provider}: ${reason}; operator review required`,
  );
}

export async function providerGet(
  url: string,
  options: Parameters<typeof axios.get>[1],
) {
  try {
    return await axios.get(url, {
      ...options,
      headers: { ...options?.headers, ...traceHeaders() },
    });
  } catch {
    // Axios errors can contain authorization headers and raw response bodies.
    throw new ProviderFetchError(
      'unavailable',
      'Provider unavailable; retry later',
    );
  }
}

export function checkHttpStatus(provider: string, status: number): void {
  if (status >= 500 || status === 408) {
    throw new ProviderFetchError(
      'unavailable',
      `${provider} API error: ${status}`,
    );
  }
  if (status !== 200) {
    throw new ProviderFetchError(
      'access_denied',
      `${provider} API rejected request: ${status}; operator review required`,
    );
  }
}

export const CLOCK_SKEW_MS = 60_000;
export const MAX_LIVE_DURATION_MS = 24 * 60 * 60 * 1_000;
// Correspondence games can span years. This is a conservative evidence ceiling,
// not a time-control calculation (increments and vacations extend wall time).
export const MAX_CORRESPONDENCE_DURATION_MS = 10 * 366 * MAX_LIVE_DURATION_MS;

export function validateChronology(
  provider: string,
  start: unknown,
  end: unknown,
  correspondence = false,
): void {
  const maxDuration = correspondence
    ? MAX_CORRESPONDENCE_DURATION_MS
    : MAX_LIVE_DURATION_MS;
  if (
    typeof start !== 'number' ||
    typeof end !== 'number' ||
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start <= 0 ||
    end <= 0 ||
    end < start ||
    end > Date.now() + CLOCK_SKEW_MS ||
    end - start > maxDuration
  ) {
    quarantine(provider, 'invalid_chronology');
  }
}
