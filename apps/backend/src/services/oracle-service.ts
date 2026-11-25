/**
 * Oracle Service
 *
 * Contains all business logic for verifying chess game results before they
 * can be submitted on-chain. Route handlers in routes/oracle.ts delegate here
 * so that the logic can be tested independently of HTTP concerns.
 */

import { fetchLichessResult, GameNotFoundError } from '../fetchers/lichess.js';
import { fetchChessDotComResult } from '../fetchers/chessdotcom.js';
import { AmbiguousEvidenceError } from '../fetchers/result.js';
import { verifyPlayerIdentities, verifyIdentityHash } from './player-identity.js';
import type { PlayerIdentityMap } from './player-identity.js';
import type { MatchStorePort } from '../store/match-store.js';
import type { Decision, EvidenceStore } from '../store/evidence-store.js';
import { withGameLock } from '../store/evidence-store.js';
import logger from '../logger.js';
import { errorToHttpStatus, ValidationError, NotFoundError } from '../errors/errorToHttpStatus.js';
import { getOracleConfig } from './oracle-config.js';

export interface SubmitResultInput {
  matchId: number;
  gameId: string;
  platform: string;
  username?: string;
}

export interface SubmitResultSuccess {
  ok: true;
  verified: true;
  matchId: number;
  gameId: string;
  result: string | null;
  provider: 'lichess' | 'chessdotcom';
  decisionId?: number;
  whitePlayer: string;
  blackPlayer: string;
  status: string;
  message: string;
}

export interface SubmitResultFailure {
  ok: false;
  status: number;
  error: string;
  decisionId?: number;
  details?: string;
  hint?: string;
}

export type SubmitResultOutcome = SubmitResultSuccess | SubmitResultFailure;

async function appendDecision(
  ledger: EvidenceStore | undefined,
  decision: Decision,
): Promise<number | undefined> {
  const decisionId = await ledger?.append(decision);
  if (decisionId !== undefined) {
    logger.info(
      {
        game_id: decision.gameId,
        match_id: decision.matchId,
        decision_id: decisionId,
      },
      'oracle_decision_recorded',
    );
  }
  return decisionId;
}

/**
 * Validate the input fields for a submit-result request.
 *
 * Returns an error string if validation fails, or null if valid.
 */
export function validateSubmitResultInput(input: Partial<SubmitResultInput>): string | null {
  const { matchId, gameId, platform, username } = input;

  // #1717 — matchId is forwarded to the Stellar transaction builder, which
  // expects a positive integer (a contract-side u64 match id). A non-numeric
  // value, a float, zero, or a negative number must be rejected here, at the
  // route layer, rather than surfacing as a runtime error deep in the
  // transaction-building call stack.
  if (typeof matchId !== 'number' || !Number.isInteger(matchId) || matchId <= 0) {
    return 'matchId must be a positive integer';
  }
  if (!gameId || typeof gameId !== 'string' || gameId.length === 0) {
    return 'gameId is required';
  }
  if (!platform || (platform !== 'lichess' && platform !== 'chessdotcom')) {
    return 'platform must be lichess or chessdotcom';
  }
  if (platform === 'chessdotcom' && (!username || typeof username !== 'string')) {
    return 'username is required for chessdotcom';
  }
  return null;
}

/**
 * Orchestrate the oracle result-verification flow:
 *   1. Find the match by gameId in the store
 *   2. Ensure player identities were captured at match creation
 *   3. Fetch the game result from the chess platform API
 *   4. Verify that the API players match the registered players
 *
 * Returns a discriminated union so the route handler only needs to map the
 * result to an HTTP response.
 */
export function verifyGameResult(
  store: MatchStorePort,
  input: SubmitResultInput,
  ledger?: EvidenceStore,
): Promise<SubmitResultOutcome> {
  const verify = () => verifyGameResultCore(store, input, ledger);
  return ledger ? withGameLock(input.gameId, verify) : verify();
}

async function verifyGameResultCore(
  store: MatchStorePort,
  input: SubmitResultInput,
  ledger?: EvidenceStore,
): Promise<SubmitResultOutcome> {
  const { matchId, gameId, platform, username } = input;
  const history = ledger ? await ledger.history(gameId) : [];
  const latestDecision = history[history.length - 1];
  if (
    latestDecision?.state === 'review_required' ||
    latestDecision?.state === 'operator_decided'
  ) {
    return {
      ok: false,
      status: 409,
      error: 'Evidence requires operator review',
      decisionId: latestDecision.id,
      details: latestDecision.reason,
    };
  }

  // Fetch the match record
  const match = await store.findByGameId(gameId);
  if (!match) {
    const storeSize = await store.count();

    if (storeSize === 0) {
      logger.error(
        { game_id: gameId, match_id: matchId, store_count: 0 },
        'oracle_match_not_found_empty_store',
      );
      return {
        ok: false,
        status: errorToHttpStatus(new NotFoundError('Match not found')),
        error: 'Match not found',
        details: `No match found for gameId: ${gameId}. The match store is empty — the server may have restarted and lost in-memory state. Check your persistence configuration (QUEUE_STORE env var) and ensure matches are written to a durable store before deploying.`,
        hint: 'persistence_loss_suspected',
      };
    }

    logger.warn(
      { game_id: gameId, match_id: matchId, store_count: storeSize },
      'oracle_match_not_found',
    );
    return {
      ok: false,
      status: errorToHttpStatus(new NotFoundError('Match not found')),
      error: 'Match not found',
      details: `No match found for gameId: ${gameId}`,
    };
  }

  // Ensure player identities were captured at match creation
  if (!match.player1Username || !match.player2Username) {
    return {
      ok: false,
      status: errorToHttpStatus(new ValidationError('Player identities not recorded')),
      error: 'Player identities not recorded',
      details: 'Match was created without capturing player identities from the API',
    };
  }

  // #1721 — the fetcher used to pull a result must be the platform the match
  // was actually created on (match.platform), never the caller-supplied
  // `platform` from the request body. Without this check, a caller could ask
  // the oracle to verify a Lichess match's gameId against the Chess.com API
  // (or vice versa) by simply passing a different `platform` value, which
  // would either fail confusingly deep in the fetcher or — if the gameId
  // happened to also resolve on the other platform — verify the wrong game
  // entirely. `match.platform` is immutable after creation, so it is the
  // only trustworthy source for which fetcher to use.
  if (platform !== match.platform) {
    return {
      ok: false,
      status: errorToHttpStatus(new ValidationError('Platform mismatch')),
      error: 'Platform mismatch',
      details: `Match ${match.matchId} was created on platform '${match.platform}', but this request specified '${platform}'. The platform used to verify a result must match the platform recorded at match creation.`,
    };
  }

  // #2124 — read the tunable oracle parameters on every verification so that
  // operator changes (retry count, timeout, batch size) take effect without a
  // restart. Defaults are used when no override has been configured.
  const oracleConfig = getOracleConfig();

  // Fetch the game result from the chess platform API, using the match's own
  // recorded platform (now confirmed consistent with the request above) as
  // the sole source of truth for fetcher selection. The upstream fetch is
  // bounded by the runtime-configurable timeout.
  let apiResult;
  try {
    if (match.platform === 'lichess') {
      apiResult = await withTimeout(
        fetchLichessResult(gameId),
        oracleConfig.timeoutMs,
        `Lichess fetch for game ${gameId}`,
      );
    } else if (match.platform === 'chessdotcom') {
      apiResult = await withTimeout(
        fetchChessDotComResult(username as string, gameId),
        oracleConfig.timeoutMs,
        `Chess.com fetch for game ${gameId}`,
      );
    } else {
      return {
        ok: false,
        status: errorToHttpStatus(new ValidationError('Unknown platform')),
        error: 'Unknown platform',
        details: `Match ${match.matchId} has an unrecognized platform '${match.platform}'; expected 'lichess' or 'chessdotcom'.`,
      };
    }
  } catch (error) {
    if (error instanceof AmbiguousEvidenceError) {
      const decisionId = await appendDecision(ledger, {
        matchId: match.matchId,
        gameId,
        state: 'review_required',
        reason: error.message,
        evidence: error.evidence,
        recordedAt: new Date().toISOString(),
      });
      logger.warn(
        {
          game_id: gameId,
          match_id: match.matchId,
          decision_id: decisionId,
          reason: error.message,
        },
        'oracle_ambiguous_result_requires_review',
      );
      return {
        ok: false,
        status: 409,
        error: 'Result requires operator review',
        decisionId,
        details: error.message,
      };
    }
    if (error instanceof GameNotFoundError) {
      return {
        ok: false,
        status: errorToHttpStatus(error),
        error: 'Game not found on platform',
        details: error.message,
      };
    }
    throw error;
  }

  const provider = apiResult.evidence.provider;
  // #2124 — scan the decision history in runtime-configurable batches so a
  // large history does not block the event loop in one pass.
  const previousProvider = await findInBatches(
    history,
    oracleConfig.batchSize,
    (decision) => decision.provider ?? decision.evidence?.provider,
  );
  if (previousProvider && previousProvider !== provider) {
    await appendDecision(ledger, {
      matchId: match.matchId,
      gameId,
      state: 'provider_changed',
      reason: 'Result provider changed',
      provider,
      previousProvider,
      evidence: apiResult.evidence,
      recordedAt: new Date().toISOString(),
    });
  }

  // Retain only normalized fields used for the decision; raw provider data is
  // discarded. Append once the decision is known so every evaluation stays
  // reproducible, including rejected results.
  const evidence = {
    parserVersion: 'chess-result-v1',
    evaluatedAt: new Date().toISOString(),
    matchId: match.matchId,
    gameId: apiResult.gameId,
    platform: match.platform,
    provider,
    whitePlayer: apiResult.whitePlayer.trim().toLowerCase(),
    blackPlayer: apiResult.blackPlayer.trim().toLowerCase(),
    result: apiResult.result,
    status: apiResult.status,
  };

  const submissionTime = Date.now();
  const gameEndTime = apiResult.endedAt ? Date.parse(apiResult.endedAt) : NaN;
  if (
    apiResult.result === null ||
    apiResult.status !== 'finished' ||
    !Number.isFinite(gameEndTime) ||
    submissionTime < gameEndTime
  ) {
    const details =
      apiResult.result === null || apiResult.status !== 'finished'
        ? `Provider ${provider} has not confirmed that the game is finished.`
        : !Number.isFinite(gameEndTime)
          ? `Provider ${provider} did not supply a valid game end time.`
          : `Submission time ${new Date(submissionTime).toISOString()} precedes provider game end time ${apiResult.endedAt}.`;
    const reason = `Result submission timing violation: ${details}`;
    const decisionId = await appendDecision(ledger, {
      matchId: match.matchId,
      gameId,
      state: 'in_progress',
      reason,
      provider,
      evidence: apiResult.evidence,
      recordedAt: new Date(submissionTime).toISOString(),
    });
    return {
      ok: false,
      status: 425,
      error: 'Result submission timing violation',
      decisionId,
      details,
    };
  }

  // #2093 — validate that the result timestamp falls within the valid window:
  // after the match was created and before the current time. Future timestamps
  // and timestamps predating match creation are rejected before reaching the
  // chain.
  const matchCreatedAt = match.createdAt ? Date.parse(match.createdAt) : NaN;
  if (!Number.isFinite(matchCreatedAt)) {
    const details = `Match ${match.matchId} does not have a valid creation timestamp.`;
    await ledger?.append({
      matchId: match.matchId,
      gameId,
      state: 'review_required',
      reason: `Invalid result timestamp: ${details}`,
      provider,
      evidence: apiResult.evidence,
      recordedAt: new Date(submissionTime).toISOString(),
    });
    return {
      ok: false,
      status: errorToHttpStatus(new ValidationError('Invalid result timestamp')),
      error: 'Invalid result timestamp',
      details,
    };
  }
  if (gameEndTime <= matchCreatedAt) {
    const details = `Result timestamp ${new Date(gameEndTime).toISOString()} precedes match creation time ${new Date(matchCreatedAt).toISOString()}.`;
    await ledger?.append({
      matchId: match.matchId,
      gameId,
      state: 'review_required',
      reason: `Invalid result timestamp: ${details}`,
      provider,
      evidence: apiResult.evidence,
      recordedAt: new Date(submissionTime).toISOString(),
    });
    return {
      ok: false,
      status: errorToHttpStatus(new ValidationError('Invalid result timestamp')),
      error: 'Invalid result timestamp',
      details,
    };
  }
  if (gameEndTime > submissionTime) {
    const details = `Result timestamp ${new Date(gameEndTime).toISOString()} is in the future (current time ${new Date(submissionTime).toISOString()}).`;
    await ledger?.append({
      matchId: match.matchId,
      gameId,
      state: 'review_required',
      reason: `Invalid result timestamp: ${details}`,
      provider,
      evidence: apiResult.evidence,
      recordedAt: new Date(submissionTime).toISOString(),
    });
    return {
      ok: false,
      status: errorToHttpStatus(new ValidationError('Invalid result timestamp')),
      error: 'Invalid result timestamp',
      details,
    };
  }

  // Build the identity map from the match record
  const identityMap: PlayerIdentityMap = {
    player1Address: match.player1,
    player1Username: match.player1Username,
    player2Address: match.player2,
    player2Username: match.player2Username,
    platform,
  };

  // Verify that the API players match the registered players
  const verification = verifyPlayerIdentities(match, apiResult, identityMap);
  if (!verification.valid) {
    await store.saveSettlementEvidence({ ...evidence, decision: 'player_identity_mismatch' });
    const decisionId = await appendDecision(ledger, {
      matchId: match.matchId,
      gameId,
      state: 'review_required',
      reason: 'Player identity verification failed',
      provider,
      evidence: apiResult.evidence,
      recordedAt: evidence.evaluatedAt,
    });
    return {
      ok: false,
      status: errorToHttpStatus(new ValidationError('Player identity verification failed')),
      error: 'Player identity verification failed',
      decisionId,
      details: verification.error,
    };
  }

  // #1720 — the identity hash bound to the match at creation time must still
  // match a hash recomputed from its current fields. A divergence means the
  // identity captured at creation is no longer what the record now shows —
  // reject rather than accept a result against an identity that may have
  // been swapped after creation.
  const identityHashCheck = verifyIdentityHash(match);
  if (!identityHashCheck.valid) {
    await store.saveSettlementEvidence({ ...evidence, decision: 'identity_hash_mismatch' });
    const decisionId = await appendDecision(ledger, {
      matchId: match.matchId,
      gameId,
      state: 'review_required',
      reason: 'Identity hash verification failed',
      provider,
      evidence: apiResult.evidence,
      recordedAt: evidence.evaluatedAt,
    });
    return {
      ok: false,
      status: errorToHttpStatus(new ValidationError('Identity hash verification failed')),
      error: 'Identity hash verification failed',
      decisionId,
      details: identityHashCheck.error,
    };
  }

  if (apiResult.result !== null) {
    const previousVerifiedFromOtherProvider = await findInBatches(
      history,
      oracleConfig.batchSize,
      (decision) => {
        const decisionProvider =
          decision.provider ?? decision.evidence?.provider;
        return (
          decision.state === 'verified' &&
          decisionProvider !== undefined &&
          decisionProvider !== provider &&
          decision.evidence?.outcome !== undefined &&
          decision.evidence.outcome !== null
        );
      },
    );
    const conflictingProvider =
      previousVerifiedFromOtherProvider?.provider ??
      previousVerifiedFromOtherProvider?.evidence?.provider;
    const conflictingOutcome =
      previousVerifiedFromOtherProvider?.evidence?.outcome;
    if (
      conflictingProvider !== undefined &&
      conflictingOutcome !== undefined &&
      conflictingOutcome !== null &&
      conflictingOutcome !== apiResult.result
    ) {
      const reason =
        `Provider outcome contradiction: ${conflictingProvider} reported ` +
        `${conflictingOutcome}, while ${provider} reported ${apiResult.result}.`;
      const decisionId = await appendDecision(ledger, {
        matchId: match.matchId,
        gameId,
        state: 'review_required',
        reason,
        provider,
        previousProvider: conflictingProvider,
        evidence: apiResult.evidence,
        previousEvidence: previousVerifiedFromOtherProvider.evidence,
        recordedAt: evidence.evaluatedAt,
      });
      return {
        ok: false,
        status: 409,
        error: 'Provider outcome contradiction',
        decisionId,
        details: reason,
      };
    }

    const previousVerified = await findInBatches(
      history,
      oracleConfig.batchSize,
      (decision) => decision.state === 'verified',
    );
    if (
      previousVerified?.evidence?.outcome !== undefined &&
      previousVerified.evidence.outcome !== apiResult.result
    ) {
      const decisionId = await appendDecision(ledger, {
        matchId: match.matchId,
        gameId,
        state: 'review_required',
        reason: 'Provider outcome changed after verification',
        provider,
        evidence: apiResult.evidence,
        recordedAt: evidence.evaluatedAt,
      });
      return {
        ok: false,
        status: 409,
        error: 'Provider outcome changed after verification',
        decisionId,
      };
    }
    await store.saveSettlementEvidence({ ...evidence, decision: 'verified' });
  }
  const decisionId = await appendDecision(ledger, {
    matchId: match.matchId,
    gameId,
    state: apiResult.result === null ? 'in_progress' : 'verified',
    reason: apiResult.result === null ? 'Game is still in progress' : 'Result verified',
    provider,
    evidence: apiResult.evidence,
    recordedAt: evidence.evaluatedAt,
  });
  return {
    ok: true,
    verified: true,
    decisionId,
    matchId: match.matchId,
    gameId: apiResult.gameId,
    result: apiResult.result,
    provider,
    whitePlayer: apiResult.whitePlayer,
    blackPlayer: apiResult.blackPlayer,
    status: apiResult.status,
    message: 'Game result verified. Players match registered identities.',
  };
}

/**
 * Reject with a descriptive error if `promise` does not settle within
 * `timeoutMs`. Used to bound upstream platform fetches by the runtime
 * configurable oracle timeout.
 */
function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return promise;
  }
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    if (typeof timer === 'object' && timer !== null && 'unref' in timer) {
      (timer as { unref: () => void }).unref();
    }
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Search `items` from newest to oldest in chunks of `batchSize`, yielding to
 * the event loop between chunks. Returns the first item for which `predicate`
 * produces a defined value, or undefined if none matches.
 */
async function findInBatches<T, R>(
  items: readonly T[],
  batchSize: number,
  predicate: (item: T) => R | undefined,
): Promise<R | undefined> {
  const size = Number.isFinite(batchSize) && batchSize > 0 ? Math.floor(batchSize) : items.length || 1;
  for (let end = items.length; end > 0; end -= size) {
    const start = Math.max(0, end - size);
    for (let i = end - 1; i >= start; i -= 1) {
      const result = predicate(items[i]);
      if (result !== undefined) {
        return result;
      }
    }
    if (start > 0) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
  return undefined;
}
