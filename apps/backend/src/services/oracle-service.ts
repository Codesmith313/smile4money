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
import type { EvidenceStore } from '../store/evidence-store.js';
import { withGameLock } from '../store/evidence-store.js';
import logger from '../logger.js';
import { errorToHttpStatus, ValidationError, NotFoundError } from '../errors/errorToHttpStatus.js';
import { validateSubmitResultInputDetailed } from './submit-result-validation.js';

export interface SubmitResultInput {
  matchId: number;
  gameId: string;
  platform: string;
  username?: string;
}

export interface SubmitResultSuccess {
  ok: true;
  verified: true;
  decisionId?: number;
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
  details?: string;
  hint?: string;
}

export type SubmitResultOutcome = SubmitResultSuccess | SubmitResultFailure;

/**
 * Validate the input fields for a submit-result request.
 *
 * Returns an error string if validation fails, or null if valid.
 */
export function validateSubmitResultInput(input: Partial<SubmitResultInput>): string | null {
  return validateSubmitResultInputDetailed(input)[0]?.message ?? null;
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
  if (latestDecision?.state === 'review_required') {
    return {
      ok: false,
      status: 409,
      error: 'Evidence requires operator review',
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

  if (match.matchId !== matchId) {
    return {
      ok: false,
      status: 400,
      error: 'Match ID does not match game',
      details: `Game ${gameId} is recorded for match ${match.matchId}, not ${matchId}`,
    };
  }

  const priorHistory = evidenceStore ? await evidenceStore.history(gameId) : [];
  const latestDecision = priorHistory[priorHistory.length - 1];
  if (
    latestDecision?.state === 'review_required' ||
    latestDecision?.state === 'operator_decided'
  ) {
    return {
      ok: false,
      status: 409,
      error: 'Result is awaiting operator review',
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

  // Fetch the game result from the chess platform API, using the match's own
  // recorded platform (now confirmed consistent with the request above) as
  // the sole source of truth for fetcher selection.
  let apiResult;
  try {
    if (match.platform === 'lichess') {
      apiResult = await fetchLichessResult(gameId);
    } else if (match.platform === 'chessdotcom') {
      apiResult = await fetchChessDotComResult(username as string, gameId);
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
      if (evidenceStore) {
        await evidenceStore.append({
          matchId: match.matchId,
          gameId,
          state: 'review_required',
          reason: error.message,
          evidence: error.evidence,
          recordedAt: new Date().toISOString(),
        });
      }
      logger.warn(
        { game_id: gameId, match_id: match.matchId, reason: error.message },
        'oracle_ambiguous_result_requires_review',
      );
      return {
        ok: false,
        status: 409,
        error: 'Result requires operator review',
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
    if (error instanceof AmbiguousEvidenceError) {
      await ledger?.append({
        matchId,
        gameId,
        state: 'review_required',
        reason: error.message,
        provider: error.evidence.provider,
        evidence: error.evidence,
        recordedAt: new Date().toISOString(),
      });
      return {
        ok: false,
        status: 409,
        error: 'Evidence requires operator review',
        details: error.message,
      };
    }
    throw error;
  }

  const provider = apiResult.evidence.provider;
  const previousProvider = history
    .slice()
    .reverse()
    .map((decision) => decision.provider ?? decision.evidence?.provider)
    .find((decision) => decision !== undefined);
  if (previousProvider && previousProvider !== provider) {
    await ledger?.append({
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
    await ledger?.append({
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
    await ledger?.append({
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
    await ledger?.append({
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
      details: identityHashCheck.error,
    };
  }

  if (apiResult.result !== null) {
    const previousVerifiedFromOtherProvider = history
      .slice()
      .reverse()
      .find((decision) => {
        const decisionProvider =
          decision.provider ?? decision.evidence?.provider;
        return (
          decision.state === 'verified' &&
          decisionProvider !== undefined &&
          decisionProvider !== provider &&
          decision.evidence?.outcome !== undefined &&
          decision.evidence.outcome !== null
        );
      });
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
      await ledger?.append({
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
        details: reason,
      };
    }

    const previousVerified = history
      .slice()
      .reverse()
      .find((decision) => decision.state === 'verified');
    if (
      previousVerified?.evidence?.outcome !== undefined &&
      previousVerified.evidence.outcome !== apiResult.result
    ) {
      await ledger?.append({
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
      };
    }
    await store.saveSettlementEvidence({ ...evidence, decision: 'verified' });
  }
  const decisionId = await ledger?.append({
    matchId: match.matchId,
    gameId,
    state: apiResult.result === null ? 'in_progress' : 'verified',
    reason: apiResult.result === null ? 'Game is still in progress' : 'Result verified',
    provider,
    evidence: apiResult.evidence,
    recordedAt: evidence.evaluatedAt,
  });

  const decisionId = evidenceStore
    ? await evidenceStore.append({
        matchId: match.matchId,
        gameId,
        state: apiResult.result === null ? 'in_progress' : 'verified',
        reason:
          apiResult.result === null
            ? 'Game is still in progress'
            : 'Game result verified',
        evidence: apiResult.evidence,
        recordedAt: new Date().toISOString(),
      })
    : undefined;

  return {
    ok: true,
    verified: true,
    decisionId,
    matchId: match.matchId,
    gameId: apiResult.gameId,
    result: apiResult.result,
    provider,
    decisionId,
    whitePlayer: apiResult.whitePlayer,
    blackPlayer: apiResult.blackPlayer,
    status: apiResult.status,
    message: 'Game result verified. Players match registered identities.',
  };
}
