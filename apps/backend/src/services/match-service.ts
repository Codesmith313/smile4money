/**
 * Match Service
 *
 * Contains all business logic for creating matches, including game existence
 * validation and player identity extraction from chess platform APIs.
 *
 * Route handlers in routes/matches.ts delegate to these functions so that
 * the business logic can be tested independently of HTTP concerns.
 */

import { GameNotFoundError } from '../fetchers/lichess.js';
import { getCachedProviderGameResult } from './game-validation-cache.js';
import type { MatchRecord } from '../store/match-store.js';
import type { MatchStorePort } from '../store/match-store.js';
import { errorToHttpStatus, ValidationError, ConflictError, NotFoundError } from '../errors/errorToHttpStatus.js';
import { logEvent } from './log-events.js';

// Mirrors contracts/escrow/src/constants.rs and contracts/smile4money-common.
export const MIN_STAKE = 1;
export const MAX_STAKE = 10_000_000_000_000;
export const MAX_GAME_ID_LEN = 64;

export interface GameValidationResult {
  valid: boolean;
  error?: string;
}

export interface PlayerIdentityResult {
  whitePlayer?: string;
  blackPlayer?: string;
  error?: string;
}

export interface CreateMatchInput {
  player2: string;
  stakeAmount: number;
  token: string;
  gameId: string;
  platform: string;
  username?: string;
}

export type CreateMatchSuccess = { ok: true; match: MatchRecord };
export type CreateMatchFailure = { ok: false; status: number; error: string; details?: string };
export type CreateMatchResult = CreateMatchSuccess | CreateMatchFailure;

/**
 * Categorised reasons a match can be cancelled.
 *
 * Each category groups concrete reasons so that cancellations can be
 * aggregated and queried by category via the API.
 */
export const CANCELLATION_REASON_CATEGORIES = {
  player_request: ['player_request', 'player_withdrew', 'mutual_agreement'],
  timeout: ['timeout', 'no_show', 'expired'],
  dispute: ['dispute', 'cheating_suspected', 'result_disputed'],
  system: ['system_error', 'game_not_found', 'invalid_game', 'other'],
} as const;

export type CancellationCategory = keyof typeof CANCELLATION_REASON_CATEGORIES;
export type CancellationReason =
  (typeof CANCELLATION_REASON_CATEGORIES)[CancellationCategory][number];

const CANCELLATION_REASON_TO_CATEGORY: Record<string, CancellationCategory> = Object.entries(
  CANCELLATION_REASON_CATEGORIES,
).reduce(
  (acc, [category, reasons]) => {
    for (const reason of reasons) {
      acc[reason] = category as CancellationCategory;
    }
    return acc;
  },
  {} as Record<string, CancellationCategory>,
);

/**
 * Resolve the category for a given cancellation reason.
 *
 * Returns null if the reason is not a recognised cancellation reason.
 */
export function getCancellationCategory(reason: string): CancellationCategory | null {
  return CANCELLATION_REASON_TO_CATEGORY[reason] ?? null;
}

export type CancelMatchSuccess = { ok: true; match: MatchRecord };
export type CancelMatchFailure = { ok: false; status: number; error: string; details?: string };
export type CancelMatchResult = CancelMatchSuccess | CancelMatchFailure;

/**
 * Validate input fields for creating a match.
 *
 * Returns an error string if validation fails, or null if valid.
 */
export function validateCreateMatchInput(
  player1: string | undefined,
  input: Partial<CreateMatchInput>,
): string | null {
  const { player2, stakeAmount, token, gameId, platform } = input;

  if (!player2 || typeof player2 !== 'string') {
    return 'player2 is required';
  }
  if (
    typeof stakeAmount !== 'number' ||
    !Number.isFinite(stakeAmount) ||
    !Number.isInteger(stakeAmount)
  ) {
    return 'stakeAmount must be a whole number of token base units';
  }
  if (stakeAmount < MIN_STAKE || stakeAmount > MAX_STAKE) {
    return `stakeAmount must be between ${MIN_STAKE} and ${MAX_STAKE} token units`;
  }
  if (!token || typeof token !== 'string') {
    return 'token is required';
  }
  if (!gameId || typeof gameId !== 'string' || gameId.length === 0) {
    return 'gameId is required';
  }
  if (Buffer.byteLength(gameId, 'utf8') > MAX_GAME_ID_LEN || !/^[A-Za-z0-9_-]+$/.test(gameId)) {
    return 'gameId must be 1-64 ASCII characters containing only letters, numbers, _ or -';
  }
  if (!platform || (platform !== 'lichess' && platform !== 'chessdotcom')) {
    return 'platform must be lichess or chessdotcom';
  }
  if (player1 && player1.toUpperCase() === player2.toUpperCase()) {
    return 'player1 and player2 must be different addresses';
  }
  return null;
}

/**
 * Verify that a chess game exists on the given platform.
 *
 * Returns `{ valid: true }` on success, or `{ valid: false, error }` if the
 * game cannot be found or the platform is not recognised.
 */
export async function validateGameExists(
  platform: string,
  gameId: string,
  username?: string,
): Promise<GameValidationResult> {
  try {
    if (platform === 'lichess') {
      await getCachedProviderGameResult('lichess', gameId);
      return { valid: true };
    } else if (platform === 'chessdotcom') {
      if (!username || username.length === 0) {
        return {
          valid: false,
          error: 'username is required for chessdotcom game validation',
        };
      }
      await getCachedProviderGameResult('chessdotcom', gameId, username);
      return { valid: true };
    }
    return { valid: false, error: 'invalid platform' };
  } catch (error) {
    if (error instanceof GameNotFoundError) {
      return { valid: false, error: error.message };
    }
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { valid: false, error: `Game validation failed: ${message}` };
  }
}

/**
 * Fetch the game result from the chess platform API and extract the
 * white/black player usernames. These are stored on the match record at
 * creation time so the oracle can verify them later.
 *
 * Returns player usernames on success, or an `error` string on failure.
 */
export async function getGameResultWithPlayerIdentities(
  platform: string,
  gameId: string,
  username?: string,
): Promise<PlayerIdentityResult> {
  try {
    if (platform === 'lichess') {
      const result = await getCachedProviderGameResult('lichess', gameId);
      return { whitePlayer: result.whitePlayer, blackPlayer: result.blackPlayer };
    } else if (platform === 'chessdotcom') {
      if (!username || username.length === 0) {
        return { error: 'username is required for chessdotcom' };
      }
      const result = await getCachedProviderGameResult('chessdotcom', gameId, username);
      return { whitePlayer: result.whitePlayer, blackPlayer: result.blackPlayer };
    }
    return { error: 'invalid platform' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    return { error: message };
  }
}

/**
 * Orchestrate the full match-creation flow:
 *   1. Validate input fields
 *   2. Fetch game result and extract player identities
 *   3. Persist the match record
 *
 * Returns a discriminated union so the route handler only needs to map the
 * result to an HTTP response.
 */
export async function createMatchForPlayer(
  store: MatchStorePort,
  player1: string,
  input: CreateMatchInput,
): Promise<CreateMatchResult> {
  const validationError = validateCreateMatchInput(player1, input);
  if (validationError) {
    return { ok: false, status: errorToHttpStatus(new ValidationError(validationError)), error: validationError };
  }

  const { player2, stakeAmount, token, gameId, platform, username } = input;

  const gameResult = await getGameResultWithPlayerIdentities(platform, gameId, username);
  if (gameResult.error) {
    return {
      ok: false,
      status: errorToHttpStatus(new ValidationError(gameResult.error)),
      error: 'Invalid game',
      details: gameResult.error,
    };
  }

  try {
    const match = await store.createMatch({
      player1,
      player2,
      player1Username: gameResult.whitePlayer,
      player2Username: gameResult.blackPlayer,
      stakeAmount,
      token,
      gameId,
      platform,
    });
    return { ok: true, match };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('duplicate')) {
      return { ok: false, status: errorToHttpStatus(new ConflictError(message)), error: 'duplicate gameId' };
    }
    return { ok: false, status: errorToHttpStatus(error), error: message };
  }
}

/**
 * Cancel a match, recording the reason and its category.
 *
 * Validates the supplied reason against the known cancellation categories,
 * persists the cancellation via the store, and emits a structured
 * `match.cancelled` event containing the matchId, gameId, reason and category.
 *
 * Returns a discriminated union so the route handler only needs to map the
 * result to an HTTP response.
 */
export async function cancelMatch(
  store: MatchStorePort,
  matchId: string,
  reason: string,
): Promise<CancelMatchResult> {
  if (!reason || typeof reason !== 'string') {
    const message = 'reason is required';
    return { ok: false, status: errorToHttpStatus(new ValidationError(message)), error: message };
  }

  const category = getCancellationCategory(reason);
  if (!category) {
    const message = `reason must be one of: ${Object.values(CANCELLATION_REASON_CATEGORIES)
      .flat()
      .join(', ')}`;
    return { ok: false, status: errorToHttpStatus(new ValidationError(message)), error: message };
  }

  try {
    const match = await store.cancelMatch(matchId, reason, category);
    if (!match) {
      const message = 'match not found';
      return { ok: false, status: errorToHttpStatus(new NotFoundError(message)), error: message };
    }

    logEvent('match.cancelled', {
      matchId: match.id,
      gameId: match.gameId,
      reason,
      category,
    });

    return { ok: true, match };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    if (message.includes('not found')) {
      return { ok: false, status: errorToHttpStatus(new NotFoundError(message)), error: message };
    }
    if (message.includes('already') || message.includes('cannot cancel')) {
      return { ok: false, status: errorToHttpStatus(new ConflictError(message)), error: message };
    }
    return { ok: false, status: errorToHttpStatus(error), error: message };
  }
}
