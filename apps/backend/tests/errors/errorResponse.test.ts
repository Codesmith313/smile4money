import { describe, it, expect } from 'vitest';
import {
  ErrorCode,
  errorEnvelope,
  statusToErrorCode,
  userFacingErrorMessage,
} from '../../src/errors/errorResponse.js';
import { newTraceContext, runWithTraceContext } from '../../src/tracing/trace-context.js';

describe('errorEnvelope (#50)', () => {
  it('includes request and correlation metadata even without an active request context', () => {
    const body = errorEnvelope(ErrorCode.VALIDATION_ERROR, 'bad input');
    expect(body.error).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'bad input',
      details: {},
      requestId: expect.stringMatching(/^[a-f0-9]{16}$/),
      correlationId: expect.stringMatching(/^[a-f0-9]{32}$/),
      timestamp: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(body.error.timestamp as string))).toBe(false);
  });

  it('merges extra fields into the error object, not the top level', () => {
    const body = errorEnvelope(ErrorCode.NOT_FOUND, 'missing', { hint: 'check the id' });
    expect(Object.keys(body)).toEqual(['error']);
    expect(body.error).toMatchObject({
      code: 'NOT_FOUND',
      message: 'missing',
      details: { hint: 'check the id' },
      hint: 'check the id',
      requestId: expect.any(String),
      correlationId: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it('accepts a plain string code for a code not in the standard set', () => {
    expect(errorEnvelope('CUSTOM_CODE', 'x').error).toMatchObject({
      code: 'CUSTOM_CODE',
      message: 'x',
      details: {},
      requestId: expect.any(String),
      correlationId: expect.any(String),
      timestamp: expect.any(String),
    });
  });

  it('includes request and correlation context when handling an HTTP request', () => {
    const context = newTraceContext();
    const body = runWithTraceContext(context, () =>
      errorEnvelope(ErrorCode.INTERNAL_ERROR, 'Try again later.'),
    );

    expect(body.error).toMatchObject({
      requestId: context.spanId,
      correlationId: context.traceId,
      timestamp: expect.any(String),
    });
    expect(Number.isNaN(Date.parse(body.error.timestamp as string))).toBe(false);
  });
});

describe('statusToErrorCode (#50)', () => {
  it('maps 400 to VALIDATION_ERROR', () => {
    expect(statusToErrorCode(400)).toBe(ErrorCode.VALIDATION_ERROR);
  });

  it('maps 401 to UNAUTHORIZED', () => {
    expect(statusToErrorCode(401)).toBe(ErrorCode.UNAUTHORIZED);
  });

  it('maps 403 to FORBIDDEN', () => {
    expect(statusToErrorCode(403)).toBe(ErrorCode.FORBIDDEN);
  });

  it('maps 404 to NOT_FOUND', () => {
    expect(statusToErrorCode(404)).toBe(ErrorCode.NOT_FOUND);
  });

  it('maps 409 to CONFLICT', () => {
    expect(statusToErrorCode(409)).toBe(ErrorCode.CONFLICT);
  });

  it('maps 429 to RATE_LIMITED', () => {
    expect(statusToErrorCode(429)).toBe(ErrorCode.RATE_LIMITED);
  });

  it('maps 503 and 504 to their service error codes', () => {
    expect(statusToErrorCode(503)).toBe(ErrorCode.SERVICE_UNAVAILABLE);
    expect(statusToErrorCode(504)).toBe(ErrorCode.UPSTREAM_TIMEOUT);
  });

  it('maps any other status to INTERNAL_ERROR', () => {
    expect(statusToErrorCode(500)).toBe(ErrorCode.INTERNAL_ERROR);
    expect(statusToErrorCode(502)).toBe(ErrorCode.INTERNAL_ERROR);
    expect(statusToErrorCode(999)).toBe(ErrorCode.INTERNAL_ERROR);
  });
});

describe('userFacingErrorMessage', () => {
  it('provides actionable public guidance without exposing exception details', () => {
    expect(userFacingErrorMessage(500)).toBe(
      'Something went wrong. Please try again later.',
    );
    expect(userFacingErrorMessage(429)).toMatch(/wait a moment/i);
  });
});
