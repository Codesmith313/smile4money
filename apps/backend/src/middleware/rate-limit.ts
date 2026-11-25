import { Request, Response, NextFunction } from 'express';
import { ErrorCode, errorEnvelope } from '../errors/errorResponse.js';
import { SqliteRateLimitStore } from '../store/sqlite-rate-limit-store.js';
import logger from '../logger.js';

/**
 * Result of a rate-limit check: whether the request is allowed, and — when
 * not — how long the caller should wait before retrying.
 */
export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/**
 * A pluggable rate-limit counter backend (#1723).
 *
 * `RateLimitStore` (in-memory, below) and `SqliteRateLimitStore`
 * (`store/sqlite-rate-limit-store.ts`) both implement this. The middleware
 * only ever depends on this interface, never on a concrete backend, so
 * swapping backends via `RATE_LIMIT_STORE` requires no change to
 * `createRateLimitMiddleware` or the routes that use it.
 */
export interface RateLimitBackend {
  isAllowed(clientId: string): Promise<RateLimitResult>;
  getRemainingTokens(clientId: string): Promise<number>;
  destroy(): Promise<void> | void;
}

/**
 * Per-tier rate-limit configuration (#2126).
 *
 * Each authenticated user is assigned a tier (via `resolveUserTier`), and each
 * tier gets its own capacity/refill budget. Unauthenticated requests fall back
 * to the `anonymous` tier, keyed by IP address.
 */
export interface RateLimitTierConfig {
  /** Maximum tokens (requests) in the bucket. */
  capacity: number;
  /** How often tokens are added, in milliseconds. */
  refillIntervalMs: number;
  /** How many tokens are added per refill interval. */
  refillAmount: number;
}

export type RateLimitTier = 'anonymous' | 'free' | 'pro' | 'enterprise';

export const DEFAULT_RATE_LIMIT_TIERS: Record<RateLimitTier, RateLimitTierConfig> = {
  anonymous: { capacity: 60, refillIntervalMs: 60_000, refillAmount: 60 },
  free: { capacity: 100, refillIntervalMs: 60_000, refillAmount: 100 },
  pro: { capacity: 1_000, refillIntervalMs: 60_000, refillAmount: 1_000 },
  enterprise: { capacity: 10_000, refillIntervalMs: 60_000, refillAmount: 10_000 },
};

/**
 * Resolve the rate-limit tier for a request. Defaults to reading the
 * authenticated user's `tier` (set by the auth middleware) and falling back to
 * `anonymous` when there is no authenticated user.
 */
export function resolveUserTier(req: Request): RateLimitTier {
  const user = (req as Request & { user?: { tier?: string } }).user;
  const tier = user?.tier?.toLowerCase();
  if (tier === 'free' || tier === 'pro' || tier === 'enterprise') {
    return tier;
  }
  return 'anonymous';
}

/**
 * Resolve the rate-limit key for a request: the authenticated user id when
 * present, otherwise the client IP address (#2126).
 */
export function resolveRateLimitKey(req: Request, trustedProxies: string[] = []): string {
  const user = (req as Request & { user?: { id?: string | number } }).user;
  if (user?.id !== undefined && user?.id !== null) {
    return `user:${user.id}`;
  }
  return `ip:${getClientIp(req, trustedProxies)}`;
}

/**
 * In-memory token-bucket rate limiter. Tracks requests per IP address.
 *
 * Each process keeps its own counters — in a horizontally scaled deployment
 * with multiple backend instances behind a load balancer, each instance
 * enforces the configured limit independently, effectively multiplying the
 * real allowed rate by the instance count (#1723). Use
 * `SqliteRateLimitStore` (via `RATE_LIMIT_STORE=sqlite`) for a limit that
 * holds across instances; this remains the default for local development
 * and single-instance deployments, where the shared-storage overhead buys
 * nothing.
 */
interface ClientBucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimitStore implements RateLimitBackend {
  private buckets: Map<string, ClientBucket> = new Map();
  private readonly capacity: number;
  private readonly refillIntervalMs: number;
  private readonly refillAmount: number;
  private cleanupInterval: NodeJS.Timeout;

  /**
   * @param capacity - Maximum tokens per bucket (e.g., 100 requests)
   * @param refillIntervalMs - Interval to add tokens (e.g., 60000ms = 1 minute)
   * @param refillAmount - Tokens to add per interval (e.g., 100 requests per minute)
   */
  constructor(capacity: number, refillIntervalMs: number, refillAmount: number) {
    this.capacity = capacity;
    this.refillIntervalMs = refillIntervalMs;
    this.refillAmount = refillAmount;

    // Clean up old buckets every 10 minutes to prevent memory leaks
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 10 * 60 * 1000);
  }

  /**
   * Check if a client has exceeded the rate limit.
   * Returns true if the request is allowed, false if rate limited.
   * When rate limited, also returns the time in seconds until the next token is available.
   */
  async isAllowed(clientId: string): Promise<RateLimitResult> {
    const now = Date.now();
    let bucket = this.buckets.get(clientId);

    if (!bucket) {
      // First request from this client
      bucket = { tokens: this.capacity - 1, lastRefill: now };
      this.buckets.set(clientId, bucket);
      return { allowed: true };
    }

    // Refill tokens based on elapsed time
    const elapsedMs = now - bucket.lastRefill;
    const refills = Math.floor(elapsedMs / this.refillIntervalMs);

    if (refills > 0) {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refills * this.refillAmount);
      bucket.lastRefill = now;
    }

    // Check if request is allowed
    if (bucket.tokens > 0) {
      bucket.tokens -= 1;
      return { allowed: true };
    }

    // Rate limited — calculate time until next refill
    const timeSinceLastRefill = now - bucket.lastRefill;
    const timeUntilNextRefillMs = this.refillIntervalMs - timeSinceLastRefill;
    const retryAfterSeconds = Math.ceil(timeUntilNextRefillMs / 1000);

    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, retryAfterSeconds),
    };
  }

  /**
   * Get the number of remaining tokens for a client (for diagnostics).
   */
  async getRemainingTokens(clientId: string): Promise<number> {
    const bucket = this.buckets.get(clientId);
    if (!bucket) {
      return this.capacity;
    }

    const now = Date.now();
    const elapsedMs = now - bucket.lastRefill;
    const refills = Math.floor(elapsedMs / this.refillIntervalMs);

    return Math.min(this.capacity, bucket.tokens + refills * this.refillAmount);
  }

  /**
   * Remove old buckets that haven't been used recently.
   * A bucket is considered stale if no requests in 30 minutes.
   */
  private cleanup(): void {
    const now = Date.now();
    const staleThresholdMs = 30 * 60 * 1000;

    for (const [clientId, bucket] of this.buckets.entries()) {
      if (now - bucket.lastRefill > staleThresholdMs) {
        this.buckets.delete(clientId);
      }
    }
  }

  /**
   * Stop the cleanup interval. Call this during server shutdown.
   */
  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}

interface RateLimitMiddlewareOptions {
  keyExtractor?: (req: Request) => string;
  statusCode?: number;
  message?: string;
  /**
   * Per-tier rate-limit configuration (#2126). When omitted, the middleware
   * uses a single flat limit derived from the store's own capacity.
   */
  tiers?: Record<RateLimitTier, RateLimitTierConfig>;
  /**
   * Resolve which tier a request belongs to. Defaults to `resolveUserTier`.
   */
  tierResolver?: (req: Request) => RateLimitTier;
  /**
   * IP addresses of proxies that this server trusts to set the X-Forwarded-For
   * header (e.g. a reverse proxy like nginx or a load balancer).
   *
   * The X-Forwarded-For header is only honored when the request's direct
   * connection peer (req.socket.remoteAddress) is in this list. Defaults to an
   * empty list, meaning the header is never trusted and the direct connection
   * IP is used for rate limiting.
   */
  trustedProxies?: string[];
}

/**
 * Express middleware factory for rate limiting by IP address.
 *
 * @param store - Any RateLimitBackend (in-memory or SQLite-backed; #1723)
 * @param options - Configuration options
 * @returns Express middleware function
 *
 * Example usage:
 * ```
 * const limiter = await createRateLimitStore(100, 60000, 100); // 100 req/min
 * router.use(createRateLimitMiddleware(limiter, { trustedProxies: ['127.0.0.1'] }));
 * ```
 */
export function createRateLimitMiddleware(
  store: RateLimitBackend,
  options?: RateLimitMiddlewareOptions,
) {
  const trustedProxies = options?.trustedProxies || [];
  const keyExtractor =
    options?.keyExtractor || ((req: Request) => resolveRateLimitKey(req, trustedProxies));
  const statusCode = options?.statusCode || 429;
  const message = options?.message || 'Too many requests, please try again later';
  const tiers = options?.tiers;
  const tierResolver = options?.tierResolver || resolveUserTier;

  return (req: Request, res: Response, next: NextFunction) => {
    const clientId = keyExtractor(req);
    const tier = tierResolver(req);
    const tierConfig = tiers?.[tier];

    // When per-tier limits are configured, namespace the key by tier so that
    // a user's counters are tracked against the budget for their tier.
    const storeKey = tierConfig ? `${tier}:${clientId}` : clientId;
    const capacity = tierConfig?.capacity;

    store
      .isAllowed(storeKey, capacity)
      .then(async (result) => {
        // Set rate limit headers for all responses
        const remainingTokens = await store.getRemainingTokens(storeKey, capacity);
        const limit = capacity ?? 100;
        const remaining = Math.max(0, remainingTokens);
        res.setHeader('X-RateLimit-Limit', String(limit));
        res.setHeader('X-RateLimit-Remaining', String(remaining));

        // X-RateLimit-Reset: seconds until the bucket is fully replenished.
        const refillIntervalMs = tierConfig?.refillIntervalMs ?? 60_000;
        const refillAmount = tierConfig?.refillAmount ?? limit;
        const tokensMissing = Math.max(0, limit - remaining);
        const resetSeconds =
          refillAmount > 0 ? Math.ceil((tokensMissing / refillAmount) * (refillIntervalMs / 1000)) : 0;
        res.setHeader('X-RateLimit-Reset', String(resetSeconds));

        if (!result.allowed) {
          // Set Retry-After header per RFC 6585
          if (result.retryAfterSeconds) {
            res.setHeader('Retry-After', String(result.retryAfterSeconds));
          }

          res.status(statusCode).json(errorEnvelope(ErrorCode.RATE_LIMITED, message));
          return;
        }

        next();
      })
      .catch((error) => {
        // A rate-limit backend failure (e.g. the shared SQLite file is
        // temporarily locked) must not take the whole route down with it —
        // log and fail open, since a brief lapse in rate limiting is a much
        // smaller problem than refusing all traffic because the limiter
        // itself errored.
        logger.error(
          { error: error instanceof Error ? error.message : String(error) },
          'rate_limit_backend_error_failing_open',
        );
        next();
      });
  };
}

export type RateLimitStoreType = 'memory' | 'sqlite';

/**
 * Decide which rate-limit backend to use for a given `RATE_LIMIT_STORE`
 * value, without touching disk (#1723). Exported for unit testing, mirroring
 * `queue.ts`'s `resolveQueueStoreType`.
 *
 *   'sqlite' / 'redis' (not yet implemented, falls back to sqlite) → sqlite
 *   'memory' / unset                                               → memory
 *
 * Unlike the queue store, memory stays the default here even in production:
 * a single-instance deployment gains nothing from the SQLite backend's extra
 * I/O, and this is only a real correctness issue once an operator actually
 * runs more than one backend instance — at which point they are expected to
 * set `RATE_LIMIT_STORE=sqlite` explicitly, which also makes the choice to
 * accept the shared-file write contention a deliberate one rather than an
 * invisible default.
 */
export function resolveRateLimitStoreType(rawValue: string | undefined): RateLimitStoreType {
  const requested = (rawValue || 'memory').toLowerCase();
  if (requested === 'sqlite' || requested === 'redis') {
    if (requested === 'redis') {
      logger.warn(
        { requested },
        'rate_limit: RATE_LIMIT_STORE=redis requested but no Redis client is installed; falling back to sqlite',
      );
    }
    return 'sqlite';
  }
  return 'memory';
}

/**
 * Build and initialize a `RateLimitBackend` per the `RATE_LIMIT_STORE`
 * environment variable (#1723). This is the entry point routes should use
 * instead of constructing `RateLimitStore` directly, so the backend they get
 * is configurable without the route itself knowing which one is active.
 */
export async function createRateLimitStore(
  capacity: number,
  refillIntervalMs: number,
  refillAmount: number,
  dbPath?: string,
): Promise<RateLimitBackend> {
  const resolved = resolveRateLimitStoreType(process.env.RATE_LIMIT_STORE);

  if (resolved === 'memory') {
    return new RateLimitStore(capacity, refillIntervalMs, refillAmount);
  }

  const store = new SqliteRateLimitStore(capacity, refillIntervalMs, refillAmount, dbPath);
  await store.initialize();
  logger.info({ store: resolved }, 'rate_limit: store initialized');
  return store;
}

/**
 * Extract the client's IP address from the request.
 *
 * The X-Forwarded-For header is only honored when the request arrives directly
 * from a trusted proxy; otherwise a client could spoof the header to cycle
 * through fake IPs and bypass per-IP rate limiting.
 */
export function getClientIp(req: Request, trustedProxies: string[]): string {
  const remoteAddress = req.socket.remoteAddress || 'unknown';

  if (trustedProxies.includes(remoteAddress)) {
    const forwarded = req.header('X-Forwarded-For');
    if (forwarded) {
      // X-Forwarded-For can be a comma-separated list; take the first IP (the original client)
      return forwarded.split(',')[0].trim();
    }
  }

  return remoteAddress;
}
