import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the provider fetchers before importing the orchestrator
vi.mock('../../src/services/providers/lichess', () => ({
  fetchLichessGame: vi.fn(),
}));

vi.mock('../../src/services/providers/chesscom', () => ({
  fetchChessComGame: vi.fn(),
}));

import { fetchLichessGame } from '../../src/services/providers/lichess';
import { fetchChessComGame } from '../../src/services/providers/chesscom';
import {
  orchestrateProviderFetch,
  type ProviderResult,
  type FailoverConfig,
} from '../../src/services/provider-failover';

const mockLichess = vi.mocked(fetchLichessGame);
const mockChessCom = vi.mocked(fetchChessComGame);

const validLichessResult: ProviderResult = {
  provider: 'lichess',
  gameId: 'abc123',
  white: 'player1',
  black: 'player2',
  result: '1-0',
  moves: ['e4', 'e5', 'Nf3'],
};

const validChessComResult: ProviderResult = {
  provider: 'chesscom',
  gameId: 'abc123',
  white: 'player1',
  black: 'player2',
  result: '1-0',
  moves: ['e4', 'e5', 'Nf3'],
};

const conflictingChessComResult: ProviderResult = {
  provider: 'chesscom',
  gameId: 'abc123',
  white: 'player1',
  black: 'player2',
  result: '0-1',
  moves: ['d4', 'd5', 'c4'],
};

const defaultConfig: FailoverConfig = {
  chain: ['lichess', 'chesscom'],
  flagConflicts: true,
};

describe('provider-failover orchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('primary success', () => {
    it('returns the primary provider result when valid', async () => {
      mockLichess.mockResolvedValue(validLichessResult);

      const result = await orchestrateProviderFetch('abc123', defaultConfig);

      expect(result.status).toBe('accepted');
      expect(result.result).toEqual(validLichessResult);
      expect(result.provider).toBe('lichess');
      expect(result.flaggedForReview).toBe(false);
      expect(mockLichess).toHaveBeenCalledTimes(1);
      expect(mockChessCom).not.toHaveBeenCalled();
    });

    it('does not query fallback when primary succeeds', async () => {
      mockLichess.mockResolvedValue(validLichessResult);

      await orchestrateProviderFetch('abc123', defaultConfig);

      expect(mockChessCom).not.toHaveBeenCalled();
    });
  });

  describe('primary invalid -> fallback success', () => {
    it('falls back to chesscom when lichess returns null', async () => {
      mockLichess.mockResolvedValue(null);
      mockChessCom.mockResolvedValue(validChessComResult);

      const result = await orchestrateProviderFetch('abc123', defaultConfig);

      expect(result.status).toBe('accepted');
      expect(result.result).toEqual(validChessComResult);
      expect(result.provider).toBe('chesscom');
      expect(mockLichess).toHaveBeenCalledTimes(1);
      expect(mockChessCom).toHaveBeenCalledTimes(1);
    });

    it('falls back to chesscom when lichess returns malformed data', async () => {
      mockLichess.mockResolvedValue({
        provider: 'lichess',
        gameId: 'abc123',
        white: '',
        black: '',
        result: 'invalid',
        moves: [],
      } as unknown as ProviderResult);
      mockChessCom.mockResolvedValue(validChessComResult);

      const result = await orchestrateProviderFetch('abc123', defaultConfig);

      expect(result.status).toBe('accepted');
      expect(result.provider).toBe('chesscom');
      expect(result.result).toEqual(validChessComResult);
    });

    it('falls back to chesscom when lichess throws', async () => {
      mockLichess.mockRejectedValue(new Error('network error'));
      mockChessCom.mockResolvedValue(validChessComResult);

      const result = await orchestrateProviderFetch('abc123', defaultConfig);

      expect(result.status).toBe('accepted');
      expect(result.provider).toBe('chesscom');
    });
  });

  describe('both providers agree', () => {
    it('accepts result when both providers return consistent data', async () => {
      mockLichess.mockResolvedValue(validLichessResult);
      mockChessCom.mockResolvedValue(validChessComResult);

      const result = await orchestrateProviderFetch('abc123', {
        ...defaultConfig,
        verifyWithFallback: true,
      });

      expect(result.status).toBe('accepted');
      expect(result.flaggedForReview).toBe(false);
      expect(result.result).toEqual(validLichessResult);
    });
  });

  describe('both providers conflict', () => {
    it('flags for review when providers return conflicting results', async () => {
      mockLichess.mockResolvedValue(validLichessResult);
      mockChessCom.mockResolvedValue(conflictingChessComResult);

      const result = await orchestrateProviderFetch('abc123', {
        ...defaultConfig,
        verifyWithFallback: true,
      });

      expect(result.status).toBe('conflict');
      expect(result.flaggedForReview).toBe(true);
      expect(result.result).toBeNull();
      expect(result.conflicts).toBeDefined();
      expect(result.conflicts?.length).toBe(2);
    });

    it('does not flag when flagConflicts is false', async () => {
      mockLichess.mockResolvedValue(validLichessResult);
      mockChessCom.mockResolvedValue(conflictingChessComResult);

      const result = await orchestrateProviderFetch('abc123', {
        ...defaultConfig,
        verifyWithFallback: true,
        flagConflicts: false,
      });

      expect(result.flaggedForReview).toBe(false);
      expect(result.result).toEqual(validLichessResult);
    });
  });

  describe('configurable chain order', () => {
    it('queries providers in configured order (chesscom first)', async () => {
      const callOrder: string[] = [];
      mockChessCom.mockImplementation(async () => {
        callOrder.push('chesscom');
        return validChessComResult;
      });
      mockLichess.mockImplementation(async () => {
        callOrder.push('lichess');
        return validLichessResult;
      });

      const result = await orchestrateProviderFetch('abc123', {
        chain: ['chesscom', 'lichess'],
        flagConflicts: true,
      });

      expect(callOrder).toEqual(['chesscom']);
      expect(result.provider).toBe('chesscom');
      expect(mockLichess).not.toHaveBeenCalled();
    });

    it('falls back in configured order when primary fails', async () => {
      const callOrder: string[] = [];
      mockChessCom.mockImplementation(async () => {
        callOrder.push('chesscom');
        return null;
      });
      mockLichess.mockImplementation(async () => {
        callOrder.push('lichess');
        return validLichessResult;
      });

      const result = await orchestrateProviderFetch('abc123', {
        chain: ['chesscom', 'lichess'],
        flagConflicts: true,
      });

      expect(callOrder).toEqual(['chesscom', 'lichess']);
      expect(result.provider).toBe('lichess');
      expect(result.status).toBe('accepted');
    });

    it('respects a single-provider chain', async () => {
      mockLichess.mockResolvedValue(null);

      const result = await orchestrateProviderFetch('abc123', {
        chain: ['lichess'],
        flagConflicts: true,
      });

      expect(result.status).toBe('failed');
      expect(mockLichess).toHaveBeenCalledTimes(1);
      expect(mockChessCom).not.toHaveBeenCalled();
    });
  });

  describe('all providers fail', () => {
    it('returns failed status when all providers return invalid data', async () => {
      mockLichess.mockResolvedValue(null);
      mockChessCom.mockResolvedValue(null);

      const result = await orchestrateProviderFetch('abc123', defaultConfig);

      expect(result.status).toBe('failed');
      expect(result.result).toBeNull();
      expect(result.flaggedForReview).toBe(false);
      expect(mockLichess).toHaveBeenCalledTimes(1);
      expect(mockChessCom).toHaveBeenCalledTimes(1);
    });

    it('returns failed status when all providers throw', async () => {
      mockLichess.mockRejectedValue(new Error('lichess down'));
      mockChessCom.mockRejectedValue(new Error('chesscom down'));

      const result = await orchestrateProviderFetch('abc123', defaultConfig);

      expect(result.status).toBe('failed');
      expect(result.result).toBeNull();
      expect(result.errors).toBeDefined();
      expect(result.errors?.length).toBe(2);
    });

    it('returns failed status when chain is empty', async () => {
      const result = await orchestrateProviderFetch('abc123', {
        chain: [],
        flagConflicts: true,
      });

      expect(result.status).toBe('failed');
      expect(mockLichess).not.toHaveBeenCalled();
      expect(mockChessCom).not.toHaveBeenCalled();
    });
  });
});