import { RateLimitError } from "../errors/RateLimitError.js";
import { ProviderFetchError } from "../fetchers/provider-validation.js";
import logger from "../logger.js";

const DEFAULT_STALE_TOLERANCE_MS = 5 * 60_000;
const DEFAULT_MAX_ENTRIES = 1_000;
const BACKGROUND_RETRY_DELAY_MS = 5_000;

export type CachedProviderResult<T> =
  | { value: T; stale: false }
  | { value: T; stale: true; cacheAgeMs: number };

interface CacheEntry<T> {
  value: T;
  fetchedAt: number;
}

interface ProviderResultCacheOptions {
  staleToleranceMs?: number;
  maxEntries?: number;
  backgroundRetryDelayMs?: number;
  now?: () => number;
  scheduleBackground?: (task: () => Promise<void>) => void;
}

export function providerCacheConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): Pick<ProviderResultCacheOptions, "staleToleranceMs"> {
  const raw = env.PROVIDER_CACHE_STALE_TOLERANCE_MS;
  if (raw === undefined || raw.trim() === "") {
    return { staleToleranceMs: DEFAULT_STALE_TOLERANCE_MS };
  }

  const staleToleranceMs = Number(raw);
  if (!Number.isSafeInteger(staleToleranceMs) || staleToleranceMs < 0) {
    throw new Error(
      "PROVIDER_CACHE_STALE_TOLERANCE_MS must be a non-negative integer",
    );
  }
  return { staleToleranceMs };
}

function isProviderUnavailable(error: unknown): boolean {
  return (
    error instanceof RateLimitError ||
    (error instanceof ProviderFetchError && error.kind === "unavailable")
  );
}

export class ProviderResultCache<T> {
  private readonly entries = new Map<string, CacheEntry<T>>();
  private readonly refreshes = new Set<string>();
  private readonly retryAfter = new Map<string, number>();
  private readonly staleToleranceMs: number;
  private readonly maxEntries: number;
  private readonly backgroundRetryDelayMs: number;
  private readonly now: () => number;
  private readonly scheduleBackground: (task: () => Promise<void>) => void;
  private generation = 0;

  constructor(options: ProviderResultCacheOptions = {}) {
    this.staleToleranceMs =
      options.staleToleranceMs ?? DEFAULT_STALE_TOLERANCE_MS;
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
    this.backgroundRetryDelayMs =
      options.backgroundRetryDelayMs ?? BACKGROUND_RETRY_DELAY_MS;
    this.now = options.now ?? Date.now;
    this.scheduleBackground =
      options.scheduleBackground ??
      ((task) => {
        setImmediate(() => void task());
      });

    if (
      !Number.isSafeInteger(this.staleToleranceMs) ||
      this.staleToleranceMs < 0
    ) {
      throw new Error("Stale tolerance must be a non-negative integer");
    }
    if (!Number.isSafeInteger(this.maxEntries) || this.maxEntries < 1) {
      throw new Error(
        "Maximum provider cache entries must be a positive integer",
      );
    }
    if (
      !Number.isSafeInteger(this.backgroundRetryDelayMs) ||
      this.backgroundRetryDelayMs < 0
    ) {
      throw new Error("Background retry delay must be a non-negative integer");
    }
  }

  async get(
    key: string,
    provider: string,
    load: () => Promise<T>,
  ): Promise<CachedProviderResult<T>> {
    const cached = this.read(key);
    const ageMs = cached ? this.age(cached) : 0;

    if (
      cached &&
      this.staleToleranceMs > 0 &&
      ageMs <= this.staleToleranceMs &&
      (this.refreshes.has(key) || this.now() < (this.retryAfter.get(key) ?? 0))
    ) {
      return { value: cached.value, stale: true, cacheAgeMs: ageMs };
    }

    try {
      const value = await load();
      this.write(key, value);
      this.retryAfter.delete(key);
      return { value, stale: false };
    } catch (error) {
      const currentAgeMs = cached ? this.age(cached) : 0;
      if (
        !cached ||
        this.staleToleranceMs === 0 ||
        currentAgeMs > this.staleToleranceMs ||
        !isProviderUnavailable(error)
      ) {
        throw error;
      }

      this.scheduleRefresh(key, provider, load);
      return {
        value: cached.value,
        stale: true,
        cacheAgeMs: currentAgeMs,
      };
    }
  }

  clear(): void {
    this.generation += 1;
    this.entries.clear();
    this.refreshes.clear();
    this.retryAfter.clear();
  }

  private read(key: string): CacheEntry<T> | undefined {
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key);
      this.entries.set(key, entry);
    }
    return entry;
  }

  private write(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, { value, fetchedAt: this.now() });
    while (this.entries.size > this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey === undefined) break;
      this.entries.delete(oldestKey);
      this.retryAfter.delete(oldestKey);
    }
  }

  private age(entry: CacheEntry<T>): number {
    return Math.max(0, this.now() - entry.fetchedAt);
  }

  private scheduleRefresh(
    key: string,
    provider: string,
    load: () => Promise<T>,
  ): void {
    const now = this.now();
    if (this.refreshes.has(key) || now < (this.retryAfter.get(key) ?? 0)) {
      return;
    }

    this.refreshes.add(key);
    this.retryAfter.set(key, now + this.backgroundRetryDelayMs);
    const generation = this.generation;
    this.scheduleBackground(async () => {
      try {
        const value = await load();
        if (generation === this.generation) {
          this.write(key, value);
          this.retryAfter.delete(key);
        }
      } catch (error) {
        if (generation === this.generation && !isProviderUnavailable(error)) {
          this.entries.delete(key);
          this.retryAfter.delete(key);
        }
        logger.warn(
          {
            provider,
            error: error instanceof Error ? error.name : "UnknownError",
          },
          "provider_cache: background refresh failed",
        );
      } finally {
        if (generation === this.generation) this.refreshes.delete(key);
      }
    });
  }
}
