import axios from 'axios';
import { privateEnv } from '../config/private-env.js';
import { getLichessLimiterSingleton } from './bottleneck-limiters.js';
import logger from '../logger.js';
import { traceHeaders } from '../tracing/trace-context.js';

export class GameNotFoundError extends Error {
  constructor(gameId: string) {
    super(`Lichess game not found: ${gameId}`);
    this.name = 'GameNotFoundError';
  }
}

export class RateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super(`Lichess API rate limit exceeded (retry after ${retryAfterMs}ms)`);
    this.name = 'RateLimitError';
    this.retryAfterMs = retryAfterMs;
  }
}

export class ProviderSchemaError extends Error {
  constructor(message: string) {
    super(`Lichess API schema error: ${message}`);
    this.name = 'ProviderSchemaError';
  }
}

export interface LichessGame {
  id: string;
  winner?: 'white' | 'black';
  status: string;
  opening?: { name?: string };
}

const MAX_ATTEMPTS = 3;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8000;
const DEFAULT_RETRY_AFTER_MS = 1000;

function isTimeoutError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) {
    return false;
  }
  return error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT';
}

function computeBackoffMs(attempt: number): number {
  const exponential = Math.min(BASE_BACKOFF_MS * 2 ** (attempt - 1), MAX_BACKOFF_MS);
  const jitter = Math.random() * exponential * 0.5;
  return Math.round(exponential + jitter);
}

function parseRetryAfterMs(headers: Record<string, unknown> | undefined): number {
  if (!headers) {
    return DEFAULT_RETRY_AFTER_MS;
  }
  const raw = headers['retry-after'] ?? headers['Retry-After'];
  if (raw === undefined || raw === null) {
    return DEFAULT_RETRY_AFTER_MS;
  }
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.round(seconds * 1000);
  }
  const dateMs = Date.parse(String(raw));
  if (Number.isFinite(dateMs)) {
    return Math.max(0, dateMs - Date.now());
  }
  return DEFAULT_RETRY_AFTER_MS;
}

function validateLichessGame(data: unknown): LichessGame {
  if (typeof data !== 'object' || data === null) {
    throw new ProviderSchemaError('response body is not an object');
  }
  const record = data as Record<string, unknown>;
  if (typeof record.id !== 'string') {
    throw new ProviderSchemaError('missing or invalid "id" field');
  }
  if (typeof record.status !== 'string') {
    throw new ProviderSchemaError('missing or invalid "status" field');
  }
  if (
    record.winner !== undefined &&
    record.winner !== 'white' &&
    record.winner !== 'black'
  ) {
    throw new ProviderSchemaError('invalid "winner" field');
  }
  if (record.opening !== undefined) {
    if (typeof record.opening !== 'object' || record.opening === null) {
      throw new ProviderSchemaError('invalid "opening" field');
    }
    const opening = record.opening as Record<string, unknown>;
    if (opening.name !== undefined && typeof opening.name !== 'string') {
      throw new ProviderSchemaError('invalid "opening.name" field');
    }
  }
  return data as LichessGame;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchLichessGame(gameId: string): Promise<LichessGame> {
  const token = privateEnv.lichessApiToken;
  const url = `https://lichess.org/api/game/${encodeURIComponent(gameId)}`;
  const limiter = getLichessLimiterSingleton();
  const traceId = traceHeaders()['x-trace-id'];

  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      return await limiter.schedule(async () => {
        const response = await axios.get(url, {
          headers: {
            Accept: 'application/json',
            ...traceHeaders(),
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          timeout: 10000,
          validateStatus: (status) => status < 500,
        });

        if (response.status === 404) {
          throw new GameNotFoundError(gameId);
        }

        if (response.status === 429) {
          throw new RateLimitError(parseRetryAfterMs(response.headers));
        }

        if (response.status !== 200) {
          throw new Error(`Lichess API request failed with status ${response.status}`);
        }

        return validateLichessGame(response.data);
      });
    } catch (error) {
      lastError = error;

      const status = axios.isAxiosError(error) ? error.response?.status : undefined;
      const message = error instanceof Error ? error.message : 'Unknown error';
      logger.error(
        {
          gameId,
          url,
          status,
          attempt,
          traceId,
          error: message,
          errorName: error instanceof Error ? error.name : undefined,
        },
        'Lichess API request failed'
      );

      if (error instanceof GameNotFoundError || error instanceof ProviderSchemaError) {
        throw error;
      }

      if (error instanceof RateLimitError) {
        if (attempt >= MAX_ATTEMPTS) {
          throw error;
        }
        await sleep(error.retryAfterMs);
        continue;
      }

      if (isTimeoutError(error)) {
        if (attempt >= MAX_ATTEMPTS) {
          throw error;
        }
        await sleep(computeBackoffMs(attempt));
        continue;
      }

      throw error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Lichess API request failed');
}
