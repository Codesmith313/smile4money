import type { NormalizedGameResult } from './result.js';
import {
  AmbiguousEvidenceError,
  evidenceFor,
  normalizeResult,
} from './result.js';
import { getChessDotComLimiterSingleton } from '../services/bottleneck-limiters.js';
import logger from '../logger.js';
import { RateLimitError } from '../errors/RateLimitError.js';
import {
  ProviderFetchError,
  providerGet,
  parseRetryAfterMs,
} from './provider-validation.js';
import type { MatchResult, GameResult } from './lichess.js';

export { GameNotFoundError } from './lichess.js';
export { RateLimitError } from '../errors/RateLimitError.js';
export type { MatchResult, GameResult };

interface ChessDotComGame {
  url: string;
  pgn: string;
  time_control: string;
  end_time: number;
  white: { username: string; result: string };
  black: { username: string; result: string };
}

const LOSS_RESULTS = new Set([
  'checkmated',
  'resigned',
  'timeout',
  'abandoned',
  'lose',
  'kingofthehill',
  'threecheck',
  'bughousepartnerlose',
]);
const DRAW_RESULTS = new Set([
  'agreed',
  'stalemate',
  'repetition',
  'insufficient',
  'timevsinsufficient',
  '50move',
]);
const IN_PROGRESS = new Set(['in_progress', 'timeout_started']);

/** Extracts the game ID from a Chess.com game URL. */
function extractGameId(url: string): string {
  return url.split('/').pop() ?? url;
}

function mapResult(
  white: string,
  black: string,
): MatchResult | null | undefined {
  if (IN_PROGRESS.has(white) && IN_PROGRESS.has(black)) return null;
  if (white === 'win' && LOSS_RESULTS.has(black)) return 'Player1Wins';
  if (black === 'win' && LOSS_RESULTS.has(white)) return 'Player2Wins';
  if (DRAW_RESULTS.has(white) && DRAW_RESULTS.has(black)) return 'Draw';
  return undefined;
}

export function parseArchiveMonths(
  raw = process.env.CHESSDOTCOM_ARCHIVE_MONTHS,
): number {
  const months = raw === undefined ? 120 : Number(raw);
  if (!Number.isInteger(months) || months < 1 || months > 600) {
    throw new Error(
      'CHESSDOTCOM_ARCHIVE_MONTHS must be an integer between 1 and 600',
    );
  }
  return months;
}

const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 250;

function isChessDotComGame(value: unknown): value is ChessDotComGame {
  if (!value || typeof value !== 'object') return false;
  const g = value as Record<string, any>;
  return (
    typeof g.url === 'string' &&
    typeof g.end_time === 'number' &&
    g.white &&
    typeof g.white === 'object' &&
    typeof g.white.username === 'string' &&
    typeof g.white.result === 'string' &&
    g.black &&
    typeof g.black === 'object' &&
    typeof g.black.username === 'string' &&
    typeof g.black.result === 'string'
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchArchive(
  username: string,
  year: number,
  month: number,
): Promise<ChessDotComGame[]> {
  const mm = String(month).padStart(2, '0');
  const url = `https://api.chess.com/pub/player/${encodeURIComponent(username)}/games/${year}/${mm}`;
  const limiter = getChessDotComLimiterSingleton();

  for (let attempt = 0; ; attempt++) {
    try {
      return await limiter.schedule(async () => {
        const response = await providerGet(url, { timeoutMs: 10_000 });

        if (response.status === 404) {
          return [];
        }

        if (response.status === 429) {
          const retryAfterMs = parseRetryAfterMs(
            response.headers?.['retry-after'],
          );
          throw new RateLimitError(
            'Chess.com API rate limit exceeded (429)',
            retryAfterMs,
          );
        }

        if (response.status === 408 || response.status >= 500) {
          throw new ProviderFetchError(
            'unavailable',
            `Chess.com API unavailable: ${response.status}`,
          );
        }

        if (response.status !== 200) {
          throw new ProviderFetchError(
            'access_denied',
            `Chess.com API error: ${response.status}`,
          );
        }

        if (
          !Array.isArray(response.data?.games) ||
          !response.data.games.every(isChessDotComGame)
        ) {
          throw new AmbiguousEvidenceError(
            'Invalid archive payload',
            evidenceFor('chessdotcom', url, response.data),
          );
        }
        return response.data.games;
      });
    } catch (error) {
      if (error instanceof RateLimitError && attempt < MAX_RETRIES) {
        const backoff =
          error.retryAfterMs ?? BASE_BACKOFF_MS * Math.pow(2, attempt);
        await sleep(backoff);
        continue;
      }
      if (error instanceof ProviderFetchError) {
        logger.error(
          { username, year, month, url, error: error.message },
          'Chess.com API archive fetch failed',
        );
        throw error;
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        { username, year, month, url, error: message },
        'Chess.com API archive fetch failed',
      );
      throw error;
    }
  }
}

/**
 * Fetches a Chess.com game result by username + gameId.
 *
 * Searches UTC monthly archives backwards, bounded by CHESSDOTCOM_ARCHIVE_MONTHS (default 120, maximum 600).
 * Throws GameNotFoundError if the game is not found in any checked archive.
 * Returns result: null when the game is still in progress.
 * Player1 = white, Player2 = black.
 */
export async function fetchChessDotComResult(
  username: string,
  gameId: string,
): Promise<NormalizedGameResult> {
  const { GameNotFoundError } = await import('./lichess.js');

  const now = new Date();
  const months = parseArchiveMonths();
  for (let i = 0; i < months; i++) {
    const d = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1),
    );
    const year = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;

    let games: ChessDotComGame[];
    try {
      games = await fetchArchive(username, year, month);
    } catch (error) {
      if (error instanceof ProviderFetchError && error.kind === 'not_found') {
        throw new GameNotFoundError(gameId);
      }
      throw error;
    }
    const matches = games.filter((g) => extractGameId(g.url) === gameId);
    if (matches.length > 1)
      throw new AmbiguousEvidenceError(
        'Duplicate game evidence',
        evidenceFor('chessdotcom', `game:${gameId}`, matches),
      );
    const game = matches[0];

    if (game) {
      const evidence = evidenceFor(
        'chessdotcom',
        `https://www.chess.com/game/live/${encodeURIComponent(gameId)}`,
        game,
      );
      const result = mapResult(game.white?.result, game.black?.result);
      if (result === undefined)
        throw new AmbiguousEvidenceError(
          'Conflicting or unknown Chess.com outcomes',
          evidence,
        );
      return normalizeResult(
        gameId,
        game.white?.username,
        game.black?.username,
        result,
        game.end_time,
        'seconds',
        evidence,
      );
    }
  }

  throw new GameNotFoundError(gameId);
}
