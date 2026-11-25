import { config } from '../config/env';
import { ProviderFetchError } from './provider-fetch-error';
import { ProviderSchemaError } from './provider-schema-error';
import { compareProviderResults } from './provider-result-comparator';
import { recordDisagreement } from './outcome-disagreement-service';

export type ProviderName = 'lichess' | 'chessdotcom';

export interface ProviderResult {
  provider: ProviderName;
  data: unknown;
  fetchedAt: string;
}

export interface FailoverAcceptedResult {
  status: 'accepted';
  result: ProviderResult;
  attemptedProviders: ProviderName[];
}

export interface FailoverFlaggedResult {
  status: 'flagged';
  results: ProviderResult[];
  attemptedProviders: ProviderName[];
  reason: string;
}

export interface FailoverFailure {
  status: 'failed';
  attemptedProviders: ProviderName[];
  errors: Array<{ provider: ProviderName; error: string }>;
}

export type FailoverOutcome =
  | FailoverAcceptedResult
  | FailoverFlaggedResult
  | FailoverFailure;

export type ProviderQueryFn = (
  provider: ProviderName,
  params: Record<string, unknown>,
) => Promise<unknown>;

const DEFAULT_CHAIN: ProviderName[] = ['lichess', 'chessdotcom'];

const VALID_PROVIDERS: ProviderName[] = ['lichess', 'chessdotcom'];

function parseChain(raw: string | undefined): ProviderName[] {
  if (!raw || raw.trim() === '') {
    return [...DEFAULT_CHAIN];
  }
  const parsed = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length > 0)
    .filter((s): s is ProviderName => VALID_PROVIDERS.includes(s as ProviderName));

  if (parsed.length === 0) {
    return [...DEFAULT_CHAIN];
  }
  // Deduplicate while preserving order.
  return Array.from(new Set(parsed));
}

export function getFallbackChain(): ProviderName[] {
  return parseChain(config.providerFallbackChain);
}

function isFallbackTrigger(err: unknown): boolean {
  if (err instanceof ProviderSchemaError) {
    return true;
  }
  if (err instanceof ProviderFetchError) {
    return err.reason === 'unavailable' || err.reason === 'invalid_data';
  }
  return false;
}

function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function queryProvider(
  queryFn: ProviderQueryFn,
  provider: ProviderName,
  params: Record<string, unknown>,
): Promise<ProviderResult> {
  const data = await queryFn(provider, params);
  return {
    provider,
    data,
    fetchedAt: new Date().toISOString(),
  };
}

/**
 * Orchestrates provider failover across a configurable ordered chain.
 *
 * - Queries providers in chain order.
 * - Falls back to the next provider on ProviderFetchError('unavailable'|'invalid_data')
 *   or ProviderSchemaError.
 * - When multiple providers return results, compares them via compareProviderResults.
 *   - Agreement: returns the accepted result (and caches it via the provided cache).
 *   - Conflict: records the disagreement and returns a flagged result for review.
 */
export async function fetchWithFailover(
  params: Record<string, unknown>,
  queryFn: ProviderQueryFn,
  options?: {
    chain?: ProviderName[];
    cache?: (result: ProviderResult) => Promise<void> | void;
  },
): Promise<FailoverOutcome> {
  const chain = options?.chain ?? getFallbackChain();
  const attemptedProviders: ProviderName[] = [];
  const errors: Array<{ provider: ProviderName; error: string }> = [];
  const results: ProviderResult[] = [];

  for (const provider of chain) {
    attemptedProviders.push(provider);
    try {
      const result = await queryProvider(queryFn, provider, params);
      results.push(result);
    } catch (err) {
      errors.push({ provider, error: describeError(err) });
      if (isFallbackTrigger(err)) {
        continue;
      }
      // Non-fallback error: stop trying further providers.
      break;
    }
  }

  if (results.length === 0) {
    return {
      status: 'failed',
      attemptedProviders,
      errors,
    };
  }

  if (results.length === 1) {
    const accepted = results[0];
    if (options?.cache) {
      await options.cache(accepted);
    }
    return {
      status: 'accepted',
      result: accepted,
      attemptedProviders,
    };
  }

  const comparison = compareProviderResults(results);

  if (comparison.agree) {
    const accepted = results[0];
    if (options?.cache) {
      await options.cache(accepted);
    }
    return {
      status: 'accepted',
      result: accepted,
      attemptedProviders,
    };
  }

  await recordDisagreement({
    params,
    results,
    reason: comparison.reason,
  });

  return {
    status: 'flagged',
    results,
    attemptedProviders,
    reason: comparison.reason,
  };
}