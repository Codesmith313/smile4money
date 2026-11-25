import { describe, expect, it } from 'vitest';
import { validateSubmitResultInputDetailed } from '../../src/services/submit-result-validation.js';

describe('validateSubmitResultInputDetailed', () => {
  it('accepts contract-compatible match ID zero', () => {
    expect(
      validateSubmitResultInputDetailed({
        matchId: 0,
        gameId: 'game-1',
        platform: 'lichess',
      }),
    ).toEqual([]);
  });

  it('reports all malformed fields in one validation response', () => {
    expect(
      validateSubmitResultInputDetailed({
        matchId: Number.MAX_SAFE_INTEGER + 1,
        gameId: ' ',
        platform: 'unknown',
        username: 12,
      }),
    ).toEqual([
      {
        field: 'matchId',
        message: 'matchId must be a non-negative safe integer',
      },
      { field: 'gameId', message: 'gameId is required' },
      { field: 'platform', message: 'platform must be lichess or chessdotcom' },
      { field: 'username', message: 'username must be a string' },
    ]);
  });

  it('requires a non-empty username for Chess.com submissions', () => {
    expect(
      validateSubmitResultInputDetailed({
        matchId: 1,
        gameId: 'game-1',
        platform: 'chessdotcom',
        username: ' ',
      }),
    ).toEqual([
      {
        field: 'username',
        message: 'username is required for chessdotcom',
      },
    ]);
  });

  it('rejects non-object bodies and oversized game IDs', () => {
    expect(validateSubmitResultInputDetailed(null)).toEqual([
      { field: 'body', message: 'Request body must be an object' },
    ]);
    expect(
      validateSubmitResultInputDetailed({
        matchId: 1,
        gameId: 'g'.repeat(512),
        platform: 'lichess',
      }),
    ).toEqual([{ field: 'gameId', message: 'gameId is too long' }]);
  });
});
