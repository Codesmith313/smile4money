import { fetchChessDotComResult } from '../fetchers/chessdotcom.js';
import { fetchLichessResult } from '../fetchers/lichess.js';
import type { Evidence, NormalizedGameResult } from '../fetchers/result.js';
import {
  ProviderResultCache,
  getProviderResultCacheTtlMs,
} from './provider-result-cache.js';

/**
 * @deprecated Use {@link getProviderResultCacheTtlMs} instead. Retained for
 * backwards compatibility; the value is now env-driven and resolved lazily.
 */
export const GAME_VALIDATION_CACHE_TTL_MS = getProviderResultCacheTtlMs();

const cache = new ProviderResultCache<NormalizedGameResult>({
  ttlMs: getProviderResultCacheTtlMs(),
});

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

/** Fetch and cache successful provider validation results. */
export function getCachedProviderGameResult(
  provider: Evidence['provider'],
  gameId: string,
  username?: string,
): Promise<NormalizedGameResult> {
  if (provider === 'chessdotcom' && !username) {
    throw new Error('username is required for chessdotcom game validation');
  }

  const key = cacheKey(provider, gameId, username);
  return cache.getOrLoad(key, () => {
    if (provider === 'lichess') {
      return fetchLichessResult(gameId);
    }
    if (username) {
      return fetchChessDotComResult(username, gameId);
    }
    throw new Error('username is required for chessdotcom game validation');
  });
}

export function clearGameValidationCache(): void {
  cache.clear();
}
