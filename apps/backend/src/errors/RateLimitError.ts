/**
 * RateLimitError is thrown when an API call hits a rate limit (429).
 * Callers should catch this error specifically and retry with backoff,
 * rather than treating it as a permanent failure.
 */
export class RateLimitError extends Error {
  readonly policy = 'retry' as const;

  /** The maximum number of requests allowed in the current window. */
  public readonly limit?: number;
  /** The number of requests remaining in the current window. */
  public readonly remaining?: number;
  /** Unix timestamp (ms) or Date at which the current window resets. */
  public readonly reset?: number | Date;
  /** Number of seconds the client should wait before retrying. */
  public readonly retryAfterSeconds?: number;

  constructor(
    message: string = 'Rate limit exceeded',
    public readonly retryAfterMs?: number,
    options?: {
      limit?: number;
      remaining?: number;
      reset?: number | Date;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = 'RateLimitError';
    Object.setPrototypeOf(this, RateLimitError.prototype);

    if (options) {
      this.limit = options.limit;
      this.remaining = options.remaining;
      this.reset = options.reset;
      this.retryAfterSeconds = options.retryAfterSeconds;
    }

    // Derive retryAfterSeconds from retryAfterMs when not explicitly provided.
    if (this.retryAfterSeconds === undefined && this.retryAfterMs !== undefined) {
      this.retryAfterSeconds = Math.max(0, Math.ceil(this.retryAfterMs / 1000));
    }
  }

  /**
   * Check if an error is a RateLimitError.
   * Useful for instanceof checks in catch blocks.
   */
  static isRateLimitError(error: unknown): error is RateLimitError {
    return error instanceof RateLimitError;
  }
}
</｜｜DSML｜｜ parameter>