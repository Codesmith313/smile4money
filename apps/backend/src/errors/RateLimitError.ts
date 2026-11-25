/**
 * RateLimitError is thrown when an API call hits a rate limit (429).
 * Callers should catch this error specifically and retry with backoff,
 * rather than treating it as a permanent failure.
 */

/**
 * Optional request context attached to a RateLimitError so that errors can be
 * logged with full context (which request failed, which attempt, and any
 * correlation/trace identifier).
 */
export interface RateLimitErrorContext {
  /** The URL (or endpoint) of the request that hit the rate limit. */
  url?: string;
  /** The attempt number (1-based) on which the rate limit was hit. */
  attempt?: number;
  /** A correlation/trace identifier for the request. */
  traceId?: string;
}

export class RateLimitError extends Error {
  readonly policy = 'retry' as const;
  public readonly url?: string;
  public readonly attempt?: number;
  public readonly traceId?: string;

  constructor(
    message: string = 'Rate limit exceeded',
    public readonly retryAfterMs?: number,
    context?: RateLimitErrorContext,
  ) {
    super(RateLimitError.buildMessage(message, retryAfterMs, context));
    this.name = 'RateLimitError';
    this.url = context?.url;
    this.attempt = context?.attempt;
    this.traceId = context?.traceId;
    Object.setPrototypeOf(this, RateLimitError.prototype);
  }

  /**
   * Build the error message, appending any available context so that the
   * message itself is useful when logged.
   */
  private static buildMessage(
    message: string,
    retryAfterMs?: number,
    context?: RateLimitErrorContext,
  ): string {
    const parts: string[] = [message];
    if (retryAfterMs !== undefined) {
      parts.push(`retryAfterMs=${retryAfterMs}`);
    }
    if (context?.url !== undefined) {
      parts.push(`url=${context.url}`);
    }
    if (context?.attempt !== undefined) {
      parts.push(`attempt=${context.attempt}`);
    }
    if (context?.traceId !== undefined) {
      parts.push(`traceId=${context.traceId}`);
    }
    return parts.join(' ');
  }

  /**
   * Check if an error is a RateLimitError.
   * Useful for instanceof checks in catch blocks.
   */
  static isRateLimitError(error: unknown): error is RateLimitError {
    return error instanceof RateLimitError;
  }
}