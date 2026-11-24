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
import { errorToHttpStatus, ValidationError, ConflictError } from '../errors/errorToHttpStatus.js';
import { logger } from '../utils/logger.js';

// Mirrors contracts/escrow/src/constants.rs and contracts/smile4money-common.
export const MIN_STAKE = 1;
export const MAX_STAKE = 10_000_000_000_000;
export const MAX_GAME_ID_LEN = 64;

/**
 * Default dispute window (in seconds) after a result is submitted during which
 * players may challenge the result. Overridable via the
 * `DISPUTE_WINDOW_SECONDS` environment variable.
 */
export const DEFAULT_DISPUTE_WINDOW_SECONDS = 3600;

/**
 * Resolve the configured dispute window duration in seconds.
 *
 * Reads `DISPUTE_WINDOW_SECONDS` from the environment, falling back to
 * {@link DEFAULT_DISPUTE_WINDOW_SECONDS} when unset or invalid.
 */
export function getDisputeWindowSeconds(): number {
  const raw = process.env.DISPUTE_WINDOW_SECONDS;
  if (raw === undefined || raw.trim() === '') {
    return DEFAULT_DISPUTE_WINDOW_SECONDS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
    logger.warn(
      { raw },
      'Invalid DISPUTE_WINDOW_SECONDS; falling back to default dispute window',
    );
    return DEFAULT_DISPUTE_WINDOW_SECONDS;
  }
  return parsed;
}

/**
 * Compute the dispute deadline (ISO timestamp) from a result submission time.
 */
export function computeDisputeDeadline(
  resultSubmittedAt: Date,
  windowSeconds: number = getDisputeWindowSeconds(),
): string {
  return new Date(resultSubmittedAt.getTime() + windowSeconds * 1000).toISOString();
}

/**
 * Determine whether the dispute window for a match is still open.
 *
 * A match with no recorded result submission has no active dispute window.
 * Returns `true` when `now` is at or before the dispute deadline.
 */
export function isDisputeWindowOpen(
  match: Pick<MatchRecord, 'resultSubmittedAt' | 'disputeDeadline'>,
  now: Date = new Date(),
): boolean {
  if (!match.resultSubmittedAt || !match.disputeDeadline) {
    return false;
  }
  const deadline = new Date(match.disputeDeadline).getTime();
  if (Number.isNaN(deadline)) {
    return false;
  }
  return now.getTime() <= deadline;
}

/**
 * Record the result submission time on a match and derive its dispute
 * deadline from the configured dispute window.
 *
 * Logs the window opening event so operators can audit dispute timing.
 */
export async function recordResultSubmission(
  store: MatchStorePort,
  matchId: string,
  submittedAt: Date = new Date(),
): Promise<MatchRecord> {
  const windowSeconds = getDisputeWindowSeconds();
  const disputeDeadline = computeDisputeDeadline(submittedAt, windowSeconds);
  const match = await store.recordResultSubmission(matchId, submittedAt, disputeDeadline);
  logger.info(
    {
      matchId,
      resultSubmittedAt: submittedAt.toISOString(),
      disputeDeadline,
      disputeWindowSeconds: windowSeconds,
    },
    'Dispute window opened for match result submission',
  );
  return match;
}

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

export type DisputeCheckSuccess = { ok: true };
export type DisputeCheckFailure = { ok: false; status: number; error: string };
export type DisputeCheckResult = DisputeCheckSuccess | DisputeCheckFailure;

/**
 * Verify that a dispute may be filed for the given match, enforcing the
 * dispute window that starts when the result was submitted.
 *
 * Returns `{ ok: true }` when the window is open, otherwise a failure with an
 * HTTP status and error message. Window rejection events are logged.
 */
export function checkDisputeWindow(
  match: MatchRecord,
  now: Date = new Date(),
): DisputeCheckResult {
  if (!match.resultSubmittedAt || !match.disputeDeadline) {
    logger.warn(
      { matchId: match.id },
      'Dispute rejected: result has not been submitted yet',
    );
    return {
      ok: false,
      status: errorToHttpStatus(new ConflictError('result not submitted')),
      error: 'result has not been submitted yet',
    };
  }

  if (!isDisputeWindowOpen(match, now)) {
    logger.warn(
      {
        matchId: match.id,
        resultSubmittedAt: match.resultSubmittedAt,
        disputeDeadline: match.disputeDeadline,
        now: now.toISOString(),
      },
      'Dispute rejected: dispute window has closed',
    );
    return {
      ok: false,
      status: errorToHttpStatus(new ConflictError('dispute window closed')),
      error: 'dispute window has closed',
    };
  }

  return { ok: true };
}

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
 * Submit a match result and open the dispute window.
 *
 * Records the submission time and computes the dispute deadline from the
 * configured window duration. Logs the window opening event.
 */
export async function submitMatchResult(
  store: MatchStorePort,
  matchId: string,
  submittedAt: Date = new Date(),
): Promise<MatchRecord> {
  return recordResultSubmission(store, matchId, submittedAt);
}
