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

export interface SubmitResultInput {
  matchId: number;
  gameId: string;
  platform: string;
  username?: string;
  /**
   * #2106 — address of the oracle submitting this result. When omitted the
   * primary oracle is assumed. Used to attribute authority per submission.
   */
  oracleAddress?: string;
}

/**
 * #2106 — a single authorized oracle signer.
 */
export interface OracleKeypair {
  /** Stellar public key (G...) identifying this oracle. */
  address: string;
  /** Secret key used to sign submissions. Never logged. */
  secret: string;
  /** Whether this oracle is the configured primary. Exactly one should be primary. */
  primary?: boolean;
}

/**
 * #2106 — configuration for the fallback oracle mechanism.
 */
export interface OracleConfig {
  /** All authorized oracles (primary + fallbacks). */
  oracles: OracleKeypair[];
  /**
   * Optional explicit primary address. When set it takes precedence over the
   * `primary` flag on individual keypairs.
   */
  primaryAddress?: string;
}

/**
 * #2106 — the resolved signer for a submission, including whether it is the
 * primary oracle and why it was selected.
 */
export interface ResolvedOracle {
  address: string;
  secret: string;
  isPrimary: boolean;
  reason: 'primary' | 'fallback' | 'explicit';
}

/**
 * #2106 — error raised when no authorized oracle can be selected.
 */
export class OracleUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OracleUnavailableError';
  }
}

/**
 * #2106 — resolve which oracle should sign a submission.
 *
 * Selection rules:
 *   1. If `requestedAddress` is provided it must be an authorized oracle;
 *      otherwise the request is rejected (no silent fallback to another key).
 *   2. Otherwise the configured primary oracle is used when available.
 *   3. If the primary is unavailable (not configured, or reported down via
 *      `isAvailable`), the first available fallback oracle is used.
 *
 * @param config     Oracle configuration (multiple keypairs + primary indicator).
 * @param requestedAddress Optional address the caller explicitly wants to use.
 * @param isAvailable Optional predicate to probe liveness of an oracle.
 */
export function resolveOracle(
  config: OracleConfig,
  requestedAddress?: string,
  isAvailable?: (address: string) => boolean,
): ResolvedOracle {
  const { oracles, primaryAddress } = config;
  if (!oracles || oracles.length === 0) {
    throw new OracleUnavailableError('No oracle keypairs configured');
  }

  const available = (address: string): boolean =>
    isAvailable ? isAvailable(address) : true;

  const primary =
    (primaryAddress
      ? oracles.find((o) => o.address === primaryAddress)
      : oracles.find((o) => o.primary)) ?? oracles.find((o) => o.primary);

  if (requestedAddress) {
    const requested = oracles.find((o) => o.address === requestedAddress);
    if (!requested) {
      throw new OracleUnavailableError(
        `Requested oracle ${requestedAddress} is not authorized`,
      );
    }
    if (!available(requested.address)) {
      throw new OracleUnavailableError(
        `Requested oracle ${requestedAddress} is unavailable`,
      );
    }
    return {
      address: requested.address,
      secret: requested.secret,
      isPrimary: primary?.address === requested.address,
      reason: 'explicit',
    };
  }

  if (primary && available(primary.address)) {
    return {
      address: primary.address,
      secret: primary.secret,
      isPrimary: true,
      reason: 'primary',
    };
  }

  const fallback = oracles.find(
    (o) => o.address !== primary?.address && available(o.address),
  );
  if (fallback) {
    return {
      address: fallback.address,
      secret: fallback.secret,
      isPrimary: false,
      reason: 'fallback',
    };
  }

  throw new OracleUnavailableError(
    'No available oracle: primary is down and no fallback oracle is available',
  );
}

/**
 * #2106 — build the on-chain submission payload, attributing the submitting
 * oracle's authority to the result.
 */
export function buildOracleSubmissionPayload(
  resolved: ResolvedOracle,
  input: SubmitResultInput,
  result: string | null,
): {
  matchId: number;
  gameId: string;
  result: string | null;
  oracleAddress: string;
  isPrimaryOracle: boolean;
} {
  return {
    matchId: input.matchId,
    gameId: input.gameId,
    result,
    oracleAddress: resolved.address,
    isPrimaryOracle: resolved.isPrimary,
  };
}

export interface SubmitResultSuccess {
  ok: true;
  verified: true;
  decisionId?: number;
  matchId: number;
  gameId: string;
  result: string | null;
  provider: 'lichess' | 'chessdotcom';
  whitePlayer: string;
  blackPlayer: string;
  status: string;
  message: string;
  /** #2106 — address of the oracle that authorized this submission. */
  oracleAddress?: string;
  /** #2106 — whether the submitting oracle was the primary. */
  isPrimaryOracle?: boolean;
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
  oracleConfig?: OracleConfig,
): Promise<SubmitResultOutcome> {
  // #2106 — resolve the signing oracle up front so an unauthorized or
  // unavailable oracle is rejected before any verification work happens.
  let resolvedOracle: ResolvedOracle | undefined;
  if (oracleConfig) {
    try {
      resolvedOracle = resolveOracle(oracleConfig, input.oracleAddress);
    } catch (error) {
      if (error instanceof OracleUnavailableError) {
        return Promise.resolve({
          ok: false,
          status: 403,
          error: 'Oracle unavailable',
          details: error.message,
        });
      }
      throw error;
    }
  }

  const verify = () => verifyGameResultCore(store, input, ledger, resolvedOracle);
  return ledger ? withGameLock(input.gameId, verify) : verify();
}

async function verifyGameResultCore(
  store: MatchStorePort,
  input: SubmitResultInput,
  ledger?: EvidenceStore,
  resolvedOracle?: ResolvedOracle,
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

  const priorHistory = ledger ? await ledger.history(gameId) : [];
  const latestPriorDecision = priorHistory[priorHistory.length - 1];
  if (
    latestPriorDecision?.state === 'review_required' ||
    latestPriorDecision?.state === 'operator_decided'
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
      await ledger?.append({
        matchId,
        gameId,
        state: 'review_required',
        reason: error.message,
        provider: error.evidence.provider,
        evidence: error.evidence,
        recordedAt: new Date().toISOString(),
      });
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

  // #2106 — attribute the submitting oracle's authority to this decision.
  const oracleAddress = resolvedOracle?.address;
  const isPrimaryOracle = resolvedOracle?.isPrimary;
  if (resolvedOracle) {
    logger.info(
      {
        game_id: gameId,
        match_id: match.matchId,
        oracle_address: resolvedOracle.address,
        is_primary_oracle: resolvedOracle.isPrimary,
        selection_reason: resolvedOracle.reason,
      },
      'oracle_submission_authority',
    );
  }

  const decisionId = await ledger?.append({
    matchId: match.matchId,
    gameId,
    state: apiResult.result === null ? 'in_progress' : 'verified',
    reason: apiResult.result === null ? 'Game is still in progress' : 'Result verified',
    provider,
    evidence: apiResult.evidence,
    recordedAt: evidence.evaluatedAt,
    oracleAddress,
    isPrimaryOracle,
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
    oracleAddress,
    isPrimaryOracle,
  };
}
