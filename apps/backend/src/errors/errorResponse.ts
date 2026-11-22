import { currentTraceContext, newTraceContext } from '../tracing/trace-context.js';

/**
 * Standard API error envelope (#50).
 *
 * Before this module, every route built its own ad-hoc error JSON shape
 * (`{ error: "some string" }`, `{ error: "some string", details, hint }`,
 * `{ error: "unauthorized", message }`, `{ error: "rate_limit_exceeded",
 * message }` — four different shapes for four different concerns). API
 * consumers had no single, reliable field to branch on.
 *
 * Every error response now follows one schema:
 *
 *   { "error": { "code": "SOME_CODE", "message": "...", "details": {} } }
 *
 * documented in docs/api-reference.md. Route handlers should build their
 * error body with `errorEnvelope()` below rather than hand-rolling one.
 */

/** Stable machine-readable error codes. Add new ones here as they're needed — keep this the single source of truth. */
export const ErrorCode = {
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVICE_UNAVAILABLE: 'SERVICE_UNAVAILABLE',
  UPSTREAM_TIMEOUT: 'UPSTREAM_TIMEOUT',
  INTERNAL_ERROR: 'INTERNAL_ERROR',
} as const;

export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

export interface ErrorEnvelope {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
    [extra: string]: unknown;
  };
}

export interface ErrorMetadata {
  requestId: string;
  correlationId: string;
  timestamp: string;
}

/** Returns the public identifiers for an error, generating a context if needed. */
export function errorMetadata(): ErrorMetadata {
  const context = currentTraceContext() ?? newTraceContext();
  return {
    requestId: context.spanId,
    correlationId: context.traceId,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Builds the standard error response body. `details` is always present;
 * additional fields are mirrored at the error level for existing clients.
 *
 * `extra` merges additional diagnostic fields (e.g. a machine-readable
 * `hint`) into the `error` object. The returned envelope has one top-level
 * key, `error`.
 */
export function errorEnvelope(
  code: ErrorCode | string,
  message: string,
  extra?: Record<string, unknown>,
): ErrorEnvelope {
  const details = extra ?? {};
  return {
    error: {
      ...extra,
      code,
      message,
      details,
      ...errorMetadata(),
    },
  };
}

/**
 * Maps an HTTP status code to the matching {@link ErrorCode}.
 *
 * Several services (`match-service.ts`, `oracle-service.ts`,
 * `validate-game-service.ts`) already decide *which* status a failure maps
 * to (400/404/409/500) but don't carry a semantic label alongside it. This
 * lets route handlers derive a stable `code` from that existing status
 * without every service needing to be rewritten to also return one.
 */
export function statusToErrorCode(status: number): ErrorCode {
  switch (status) {
    case 400:
    case 413:
    case 415:
      return ErrorCode.VALIDATION_ERROR;
    case 401:
      return ErrorCode.UNAUTHORIZED;
    case 403:
      return ErrorCode.FORBIDDEN;
    case 404:
      return ErrorCode.NOT_FOUND;
    case 409:
      return ErrorCode.CONFLICT;
    case 422:
      return ErrorCode.VALIDATION_ERROR;
    case 429:
      return ErrorCode.RATE_LIMITED;
    case 503:
      return ErrorCode.SERVICE_UNAVAILABLE;
    case 504:
      return ErrorCode.UPSTREAM_TIMEOUT;
    default:
      return ErrorCode.INTERNAL_ERROR;
  }
}

/** Safe, actionable messages for errors whose internal details must not reach clients. */
export function userFacingErrorMessage(status: number): string {
  switch (status) {
    case 400:
      return 'Check the request details and try again.';
    case 413:
      return 'The request is too large. Reduce its size and try again.';
    case 415:
      return 'The request format is not supported.';
    case 401:
      return 'Sign in with a valid account and try again.';
    case 403:
      return 'You do not have permission to perform this action.';
    case 404:
      return 'The requested resource could not be found.';
    case 409:
      return 'The request conflicts with the current state. Refresh and try again.';
    case 422:
      return 'The provided information could not be verified. Check it and try again.';
    case 429:
      return 'Too many requests. Please wait a moment before trying again.';
    case 503:
      return 'The service is temporarily unavailable. Please try again shortly.';
    case 504:
      return 'A service took too long to respond. Please try again.';
    default:
      return 'Something went wrong. Please try again later.';
  }
}
