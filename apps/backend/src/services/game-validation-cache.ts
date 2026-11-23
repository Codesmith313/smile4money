import { fetchChessDotComResult } from '../fetchers/chessdotcom.js';
import { fetchLichessResult } from '../fetchers/lichess.js';
import type { Evidence, NormalizedGameResult } from '../fetchers/result.js';

export const GAME_VALIDATION_CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 1_000;

interface CacheEntry {
  expiresAt: number;
  result: Promise<NormalizedGameResult>;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(
  provider: Evidence['provider'],
  gameId: string,
  username?: string,
): string {
  return JSON.stringify([
    provider,
    gameId,
    provider === 'chessdotcom' ? username?.trim().toLowerCase() : undefined,
  ]);
}

function prune(now: number): void {
  for (const [key, entry] of cache) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next();
    if (!oldestKey.done) cache.delete(oldestKey.value);
  }
}

/** Fetch and briefly cache successful provider validation results. */
export function getCachedProviderGameResult(
  provider: Evidence['provider'],
  gameId: string,
  username?: string,
): Promise<NormalizedGameResult> {
  if (provider === 'chessdotcom' && !username) {
    throw new Error('username is required for chessdotcom game validation');
  }

  const key = cacheKey(provider, gameId, username);
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && cached.expiresAt > now) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.result;
  }
  if (cached) cache.delete(key);

  let result: Promise<NormalizedGameResult>;
  if (provider === 'lichess') {
    result = fetchLichessResult(gameId);
  } else if (username) {
    result = fetchChessDotComResult(username, gameId);
  } else {
    throw new Error('username is required for chessdotcom game validation');
  }

  prune(now);
  const entry: CacheEntry = {
    expiresAt: Number.POSITIVE_INFINITY,
    result,
  };
  cache.set(key, entry);
  void result.then(
    () => {
      if (cache.get(key) === entry) {
        entry.expiresAt = Date.now() + GAME_VALIDATION_CACHE_TTL_MS;
      }
    },
    () => {
      if (cache.get(key) === entry) cache.delete(key);
    },
  );
  return result;
}

export function clearGameValidationCache(): void {
  cache.clear();
}
