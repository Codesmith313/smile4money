export class RateLimiter {
  private tokens: number;
  private queue: Array<() => void> = [];
  private lastRefill: number;
  private backoffUntil: number = 0;
  private consecutiveRateLimits: number = 0;
  private readonly maxBackoffMs: number = 60_000;
  private readonly baseBackoffMs: number = 1_000;

  constructor(
    private capacity: number,
    private refillIntervalMs: number,
    private refillAmount: number,
  ) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
    setInterval(() => this.refill(), this.refillIntervalMs);
  }

  private refill() {
    const now = Date.now();
    if (now - this.lastRefill < this.refillIntervalMs) {
      return;
    }
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + this.refillAmount);
    this.drainQueue();
  }

  private drainQueue() {
    const now = Date.now();
    if (now < this.backoffUntil) {
      return;
    }
    while (this.tokens > 0 && this.queue.length > 0) {
      this.tokens -= 1;
      const next = this.queue.shift();
      if (next) {
        next();
      }
    }
  }

  /**
   * Record a rate limit hit (HTTP 429). Applies exponential backoff and
   * drains the token bucket so subsequent requests are queued until the
   * backoff window elapses.
   *
   * @param retryAfterMs Optional Retry-After hint from the server (ms).
   */
  recordRateLimitHit(retryAfterMs?: number) {
    this.consecutiveRateLimits += 1;

    const exponential = Math.min(
      this.maxBackoffMs,
      this.baseBackoffMs * Math.pow(2, this.consecutiveRateLimits - 1),
    );
    const backoffMs =
      typeof retryAfterMs === 'number' && retryAfterMs > 0
        ? Math.min(this.maxBackoffMs, Math.max(retryAfterMs, exponential))
        : exponential;

    this.backoffUntil = Math.max(this.backoffUntil, Date.now() + backoffMs);
    // Drain tokens so queued work waits for the backoff window.
    this.tokens = 0;

    console.warn(
      `Lichess rate limit hit (consecutive=${this.consecutiveRateLimits}); backing off for ${backoffMs}ms`,
    );

    // Schedule a drain once the backoff window elapses.
    setTimeout(() => this.drainQueue(), backoffMs + 1);
  }

  /**
   * Reset backoff state after a successful request.
   */
  recordSuccess() {
    if (this.consecutiveRateLimits > 0) {
      this.consecutiveRateLimits = 0;
    }
    this.backoffUntil = 0;
  }

  /**
   * Returns the remaining backoff time in milliseconds (0 if none).
   */
  getBackoffRemainingMs(): number {
    return Math.max(0, this.backoffUntil - Date.now());
  }

  async schedule<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const runner = async () => {
        try {
          const result = await work();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      };

      const now = Date.now();
      if (now < this.backoffUntil) {
        console.info(
          `Lichess request queued due to backoff (${this.backoffUntil - now}ms remaining)`,
        );
        this.queue.push(runner);
        return;
      }

      if (this.tokens > 0) {
        this.tokens -= 1;
        runner();
        return;
      }

      console.info('Lichess request queued due to rate limiting');
      this.queue.push(runner);
    });
  }

  getQueueLength() {
    return this.queue.length;
  }

  getRemainingTokens() {
    return this.tokens;
  }
}