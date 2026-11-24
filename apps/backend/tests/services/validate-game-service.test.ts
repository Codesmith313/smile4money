import { providerMetadata } from '../helpers/provider-metadata.js';
/**
 * Unit tests for validate-game-service.ts
 *
 * These tests exercise the service functions in isolation — no HTTP server,
 * no real chess-platform API calls. External dependencies are vi.mock'd.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  validateGameInput,
  validateGame,
  resetValidateGameCache,
  providerCacheConfigFromEnv,
  providerFailoverConfigFromEnv,
} from '../../src/services/validate-game-service.js';
import { clearGameValidationCache } from '../../src/services/game-validation-cache.js';

// ---------------------------------------------------------------------------
// Mock external fetchers
// ---------------------------------------------------------------------------
vi.mock('../../src/fetchers/lichess.js', () => ({
  fetchLichessResult: vi.fn(),
  GameNotFoundError: class GameNotFoundError extends Error {
    constructor(gameId: string) {
      super(`Lichess game not found: ${gameId}`);
      this.name = 'GameNotFoundError';
    }
  },
}));

vi.mock('../../src/fetchers/chessdotcom.js', () => ({
  fetchChessDotComResult: vi.fn(),
}));

import { fetchLichessResult, GameNotFoundError } from '../../src/fetchers/lichess.js';
import { fetchChessDotComResult } from '../../src/fetchers/chessdotcom.js';

const mockFetchLichess = vi.mocked(fetchLichessResult);
const mockFetchChess = vi.mocked(fetchChessDotComResult);

const LICHESS_GAME = {
  ...providerMetadata(),
  gameId: 'abc123',
  status: 'finished' as const,
  whitePlayer: 'alice',
  blackPlayer: 'bob',
  result: 'Player1Wins' as const,
};

const CHESS_GAME = {
  ...providerMetadata('chessdotcom'),
  gameId: 'game42',
  status: 'finished' as const,
  whitePlayer: 'alice',
  blackPlayer: 'bob',
  result: 'Player1Wins' as const,
};

describe('provider cache configuration', () => {
  it('uses the default stale tolerance and validates overrides', () => {
    expect(providerCacheConfigFromEnv({})).toEqual({
      staleToleranceMs: 300_000,
    });
    expect(
      providerCacheConfigFromEnv({
        PROVIDER_CACHE_STALE_TOLERANCE_MS: '120000',
      }),
    ).toEqual({ staleToleranceMs: 120_000 });
    expect(
      providerCacheConfigFromEnv({
        PROVIDER_CACHE_STALE_TOLERANCE_MS: '0',
      }),
    ).toEqual({ staleToleranceMs: 0 });
    expect(() =>
      providerCacheConfigFromEnv({
        PROVIDER_CACHE_STALE_TOLERANCE_MS: '-1',
      }),
    ).toThrow('PROVIDER_CACHE_STALE_TOLERANCE_MS');
  });

  it('uses the default TTL and validates overrides', () => {
    expect(providerCacheConfigFromEnv({})).toMatchObject({
      ttlMs: 60_000,
    });
    expect(
      providerCacheConfigFromEnv({
        PROVIDER_CACHE_TTL_MS: '15000',
      }),
    ).toMatchObject({ ttlMs: 15_000 });
    expect(
      providerCacheConfigFromEnv({
        PROVIDER_CACHE_TTL_MS: '0',
      }),
    ).toMatchObject({ ttlMs: 0 });
    expect(() =>
      providerCacheConfigFromEnv({
        PROVIDER_CACHE_TTL_MS: '-5',
      }),
    ).toThrow('PROVIDER_CACHE_TTL_MS');
    expect(() =>
      providerCacheConfigFromEnv({
        PROVIDER_CACHE_TTL_MS: 'not-a-number',
      }),
    ).toThrow('PROVIDER_CACHE_TTL_MS');
  });
});

describe('provider failover configuration', () => {
  it('uses the default fallback chain', () => {
    expect(providerFailoverConfigFromEnv({})).toEqual({
      enabled: true,
      fallbackChain: ['lichess', 'chessdotcom'],
      flagConflicts: true,
    });
  });

  it('parses a custom fallback chain', () => {
    expect(
      providerFailoverConfigFromEnv({
        PROVIDER_FAILOVER_CHAIN: 'chessdotcom,lichess',
      }),
    ).toMatchObject({
      fallbackChain: ['chessdotcom', 'lichess'],
    });
  });

  it('can disable failover', () => {
    expect(
      providerFailoverConfigFromEnv({
        PROVIDER_FAILOVER_ENABLED: 'false',
      }),
    ).toMatchObject({ enabled: false });
  });

  it('rejects unknown providers in the chain', () => {
    expect(() =>
      providerFailoverConfigFromEnv({
        PROVIDER_FAILOVER_CHAIN: 'lichess,unknown',
      }),
    ).toThrow('PROVIDER_FAILOVER_CHAIN');
  });
});

// ---------------------------------------------------------------------------
// validateGameInput
// ---------------------------------------------------------------------------
describe('validateGameInput', () => {
  it('returns null for a valid lichess input', () => {
    expect(validateGameInput({ gameId: 'abc123', platform: 'lichess' })).toBeNull();
  });

  it('returns null for a valid chessdotcom input with username', () => {
    expect(validateGameInput({ gameId: 'abc123', platform: 'chessdotcom', username: 'alice' })).toBeNull();
  });

  it('returns error when gameId is missing', () => {
    expect(validateGameInput({ platform: 'lichess' })).toBe('gameId is required');
  });

  it('returns error when gameId is empty string', () => {
    expect(validateGameInput({ gameId: '', platform: 'lichess' })).toBe('gameId is required');
  });

  it('returns error when gameId is >= 512 characters', () => {
    expect(validateGameInput({ gameId: 'a'.repeat(512), platform: 'lichess' })).toBe('gameId is too long');
  });

  it('returns error when platform is missing', () => {
    expect(validateGameInput({ gameId: 'abc123' })).toBe('platform must be lichess or chessdotcom');
  });

  it('returns error when platform is unknown', () => {
    expect(validateGameInput({ gameId: 'abc123', platform: 'unknown' })).toBe('platform must be lichess or chessdotcom');
  });

  it('returns error when chessdotcom is missing username', () => {
    expect(validateGameInput({ gameId: 'abc123', platform: 'chessdotcom' }))
      .toBe('username is required for chessdotcom validation to look up game archives');
  });

  it('returns error when chessdotcom has empty username', () => {
    expect(validateGameInput({ gameId: 'abc123', platform: 'chessdotcom', username: '' }))
      .toBe('username is required for chessdotcom validation to look up game archives');
  });
});

// ---------------------------------------------------------------------------
// validateGame — lichess
// ---------------------------------------------------------------------------
describe('validateGame (lichess)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGameValidationCache();
    resetValidateGameCache();
  });

  it('returns ok:true with game details when lichess game exists', async () => {
    mockFetchLichess.mockResolvedValue(LICHESS_GAME);

    const result = await validateGame({ gameId: 'abc123', platform: 'lichess' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.valid).toBe(true);
      expect(result.platform).toBe('lichess');
      expect(result.gameId).toBe('abc123');
      expect(result.whitePlayer).toBe('alice');
      expect(result.blackPlayer).toBe('bob');
      expect(result.result).toBe('Player1Wins');
      expect(result.status).toBe('finished');
    }
  });

  it('returns ok:true with result null for in-progress lichess game', async () => {
    mockFetchLichess.mockResolvedValue({ ...LICHESS_GAME, status: 'in_progress', result: null });

    const result = await validateGame({ gameId: 'abc123', platform: 'lichess' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toBeNull();
      expect(result.status).toBe('in_progress');
    }
  });

  it('returns ok:false with status 404 when lichess game is not found', async () => {
    mockFetchLichess.mockRejectedValue(new GameNotFoundError('abc123'));

    const result = await validateGame({ gameId: 'abc123', platform: 'lichess' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.valid).toBe(false);
      expect(result.message).toContain('abc123');
    }
  });

  it('returns ok:false with status 500 on unexpected lichess error', async () => {
    mockFetchLichess.mockRejectedValue(new Error('Network failure'));

    const result = await validateGame({ gameId: 'abc123', platform: 'lichess' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.valid).toBe(false);
      expect(result.message).toContain('Validation failed');
    }
  });
});

// ---------------------------------------------------------------------------
// validateGame — chessdotcom
// ---------------------------------------------------------------------------
describe('validateGame (chessdotcom)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGameValidationCache();
    resetValidateGameCache();
  });

  it('returns ok:true with game details when chess.com game exists', async () => {
    mockFetchChess.mockResolvedValue(CHESS_GAME);

    const result = await validateGame({ gameId: 'game42', platform: 'chessdotcom', username: 'alice' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.valid).toBe(true);
      expect(result.platform).toBe('chessdotcom');
      expect(result.gameId).toBe('game42');
      expect(result.whitePlayer).toBe('alice');
      expect(result.blackPlayer).toBe('bob');
      expect(result.result).toBe('Player1Wins');
    }
  });

  it('returns ok:true with result null for in-progress chess.com game', async () => {
    mockFetchChess.mockResolvedValue({ ...CHESS_GAME, status: 'in_progress', result: null });

    const result = await validateGame({ gameId: 'game42', platform: 'chessdotcom', username: 'alice' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.result).toBeNull();
    }
  });

  it('returns ok:false with status 404 when chess.com game is not found', async () => {
    // The service catches GameNotFoundError from lichess.js (chessdotcom re-exports it from there).
    // We must use the same class instance the service will check against.
    mockFetchChess.mockRejectedValue(new GameNotFoundError('game42'));

    const result = await validateGame({ gameId: 'game42', platform: 'chessdotcom', username: 'alice' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(404);
      expect(result.valid).toBe(false);
    }
  });

  it('returns ok:false with status 500 on unexpected chess.com error', async () => {
    mockFetchChess.mockRejectedValue(new Error('Upstream error'));

    const result = await validateGame({ gameId: 'game42', platform: 'chessdotcom', username: 'alice' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(500);
      expect(result.message).toContain('Validation failed');
    }
  });
});

// ---------------------------------------------------------------------------
// validateGame — provider response caching
// ---------------------------------------------------------------------------
describe('validateGame (provider cache)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGameValidationCache();
    resetValidateGameCache();
  });

  it('serves a cache hit without calling the provider again', async () => {
    mockFetchLichess.mockResolvedValue(LICHESS_GAME);

    const first = await validateGame({ gameId: 'abc123', platform: 'lichess' });
    const second = await validateGame({ gameId: 'abc123', platform: 'lichess' });

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(mockFetchLichess).toHaveBeenCalledTimes(1);
  });

  it('treats different game ids as separate cache entries', async () => {
    mockFetchLichess.mockResolvedValue(LICHESS_GAME);

    await validateGame({ gameId: 'abc123', platform: 'lichess' });
    await validateGame({ gameId: 'def456', platform: 'lichess' });

    expect(mockFetchLichess).toHaveBeenCalledTimes(2);
  });

  it('revalidates stale entries before use', async () => {
    vi.useFakeTimers();
    try {
      mockFetchLichess.mockResolvedValue(LICHESS_GAME);

      await validateGame({ gameId: 'abc123', platform: 'lichess' });
      expect(mockFetchLichess).toHaveBeenCalledTimes(1);

      // Advance past the TTL so the cached entry is stale.
      vi.advanceTimersByTime(120_000);

      mockFetchLichess.mockResolvedValue({ ...LICHESS_GAME, result: 'Player2Wins' });
      const refreshed = await validateGame({ gameId: 'abc123', platform: 'lichess' });

      expect(mockFetchLichess).toHaveBeenCalledTimes(2);
      expect(refreshed.ok).toBe(true);
      if (refreshed.ok) {
        expect(refreshed.result).toBe('Player2Wins');
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it('resetValidateGameCache clears cached provider results', async () => {
    mockFetchLichess.mockResolvedValue(LICHESS_GAME);

    await validateGame({ gameId: 'abc123', platform: 'lichess' });
    expect(mockFetchLichess).toHaveBeenCalledTimes(1);

    resetValidateGameCache();

    await validateGame({ gameId: 'abc123', platform: 'lichess' });
    expect(mockFetchLichess).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// validateGame — provider failover
// ---------------------------------------------------------------------------
describe('validateGame (provider failover)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGameValidationCache();
    resetValidateGameCache();
  });

  it('queries the alternate provider when the primary returns invalid data', async () => {
    mockFetchLichess.mockResolvedValue({ ...LICHESS_GAME, result: 'NotARealResult' as never });
    mockFetchChess.mockResolvedValue(CHESS_GAME);

    const result = await validateGame({ gameId: 'abc123', platform: 'lichess', username: 'alice' });

    expect(mockFetchLichess).toHaveBeenCalledTimes(1);
    expect(mockFetchChess).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.valid).toBe(true);
      expect(result.platform).toBe('chessdotcom');
    }
  });

  it('uses the result when both providers agree', async () => {
    mockFetchLichess.mockResolvedValue(LICHESS_GAME);
    mockFetchChess.mockResolvedValue(CHESS_GAME);

    const result = await validateGame({ gameId: 'abc123', platform: 'lichess', username: 'alice' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.valid).toBe(true);
      expect(result.result).toBe('Player1Wins');
      expect(result.conflict).toBeFalsy();
    }
  });

  it('flags conflicting results for review', async () => {
    mockFetchLichess.mockResolvedValue(LICHESS_GAME);
    mockFetchChess.mockResolvedValue({ ...CHESS_GAME, result: 'Player2Wins' });

    const result = await validateGame({ gameId: 'abc123', platform: 'lichess', username: 'alice' });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.conflict).toBe(true);
      expect(result.needsReview).toBe(true);
    }
  });

  it('falls back to the alternate provider when the primary is not found', async () => {
    mockFetchLichess.mockRejectedValue(new GameNotFoundError('abc123'));
    mockFetchChess.mockResolvedValue(CHESS_GAME);

    const result = await validateGame({ gameId: 'abc123', platform: 'lichess', username: 'alice' });

    expect(mockFetchChess).toHaveBeenCalledTimes(1);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.platform).toBe('chessdotcom');
    }
  });

  it('returns a failure when both providers fail', async () => {
    mockFetchLichess.mockRejectedValue(new GameNotFoundError('abc123'));
    mockFetchChess.mockRejectedValue(new GameNotFoundError('abc123'));

    const result = await validateGame({ gameId: 'abc123', platform: 'lichess', username: 'alice' });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.valid).toBe(false);
    }
  });
});