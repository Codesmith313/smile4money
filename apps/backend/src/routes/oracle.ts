import { Router } from 'express';
import { matchStore, evidenceStore } from '../store/index.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission, requireSignature } from '../middleware/permissions.js';
import { Permission } from '../permissions.js';
import { validateSubmitResultInput, verifyGameResult } from '../services/oracle-service.js';
import { errorToHttpStatus } from '../errors/errorToHttpStatus.js';
import {
  errorEnvelope,
  ErrorCode,
  statusToErrorCode,
  userFacingErrorMessage,
} from '../errors/errorResponse.js';

const router = Router();
const store = matchStore;

/**
 * Dispute window duration in milliseconds. Configurable via the
 * DISPUTE_WINDOW_MS environment variable; defaults to 24 hours.
 */
const DEFAULT_DISPUTE_WINDOW_MS = 24 * 60 * 60 * 1000;

function getDisputeWindowMs(): number {
  const raw = process.env.DISPUTE_WINDOW_MS;
  if (!raw) return DEFAULT_DISPUTE_WINDOW_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DISPUTE_WINDOW_MS;
  return parsed;
}

function logDisputeWindowEvent(event: string, details: Record<string, unknown>): void {
  console.info(JSON.stringify({ event, ...details, timestamp: new Date().toISOString() }));
}

/**
 * Opens the dispute window for a match once its result has been submitted.
 * Records the submission time and deadline on the match and logs the event.
 */
function openDisputeWindow(matchId: number | string): { resultSubmittedAt: string; disputeDeadline: string } {
  const windowMs = getDisputeWindowMs();
  const submittedAt = new Date();
  const deadline = new Date(submittedAt.getTime() + windowMs);
  const resultSubmittedAt = submittedAt.toISOString();
  const disputeDeadline = deadline.toISOString();

  const match = store.getMatch(matchId);
  if (match) {
    store.updateMatch(matchId, { resultSubmittedAt, disputeDeadline });
  }

  logDisputeWindowEvent('dispute_window_opened', {
    matchId,
    resultSubmittedAt,
    disputeDeadline,
    windowMs,
  });

  return { resultSubmittedAt, disputeDeadline };
}

/**
 * Returns true when the dispute window for the given match is still open.
 * A match with no recorded deadline is treated as having no open window.
 */
function isDisputeWindowOpen(matchId: number | string): boolean {
  const match = store.getMatch(matchId);
  if (!match || !match.disputeDeadline) return false;
  const deadline = new Date(match.disputeDeadline).getTime();
  if (!Number.isFinite(deadline)) return false;
  return Date.now() <= deadline;
}

// Oracle endpoints require authentication
router.use(authenticate);

/**
 * POST /api/oracle/submit-result
 *
 * Submit a verified game result to the oracle.
 *
 * Request body:
 * ```json
 * {
 *   "matchId": 1,
 *   "gameId": "abc123",
 *   "platform": "lichess",
 *   "username": "alice"  // Optional, required for Chess.com
 * }
 * ```
 *
 * This endpoint:
 * 1. Fetches the game result from the chess platform API
 * 2. Verifies that the players in the API response match the registered players
 * 3. Returns the verified result for the oracle to submit on-chain
 *
 * The oracle (a privileged service) must then sign the result and call the
 * escrow contract's `submit_result` method on Stellar Soroban.
 */
router.post(
  '/submit-result',
  requirePermission(Permission.submit_results),
  requireSignature,
  async (req, res, next) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json(errorEnvelope(ErrorCode.VALIDATION_ERROR, 'Request body must be JSON'));
  }

  const inputError = validateSubmitResultInput(payload);
  if (inputError) {
    return res.status(400).json(errorEnvelope(ErrorCode.VALIDATION_ERROR, inputError));
  }

  try {
    const result = await verifyGameResult(store, {
      matchId: payload.matchId,
      gameId: payload.gameId,
      platform: payload.platform,
      username: typeof payload.username === 'string' ? payload.username : undefined,
    }, evidenceStore);

    if (!result.ok) {
      const message =
        result.status >= 500
          ? userFacingErrorMessage(result.status)
          : result.details
            ? `${result.error}: ${result.details}`
            : result.error;
      const extra = result.hint ? { hint: result.hint } : undefined;
      return res.status(result.status).json(errorEnvelope(statusToErrorCode(result.status), message, extra));
    }

    const { resultSubmittedAt, disputeDeadline } = openDisputeWindow(result.matchId);

    return res.status(200).json({
      decisionId: result.decisionId,
      verified: result.verified,
      matchId: result.matchId,
      gameId: result.gameId,
      result: result.result,
      provider: result.provider,
      whitePlayer: result.whitePlayer,
      blackPlayer: result.blackPlayer,
      status: result.status,
      message: result.message,
      resultSubmittedAt,
      disputeDeadline,
    });
  } catch (error) {
    // #47 — mapped centrally so e.g. an upstream RateLimitError surfaces as
    // 429 here instead of always flattening to 500.
    const status = errorToHttpStatus(error);
    return res
      .status(status)
      .json(
        errorEnvelope(
          statusToErrorCode(status),
          userFacingErrorMessage(status),
        ),
      );
  }
  },
);

/**
 * POST /api/oracle/dispute
 *
 * Raise a dispute against a submitted result. Only accepted while the
 * dispute window opened at result submission is still active.
 *
 * Request body:
 * ```json
 * {
 *   "matchId": 1,
 *   "reason": "Incorrect result reported"
 * }
 * ```
 */
router.post('/dispute', async (req, res) => {
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    return res.status(400).json(errorEnvelope(ErrorCode.VALIDATION_ERROR, 'Request body must be JSON'));
  }

  const matchId = payload.matchId;
  if (matchId === undefined || matchId === null || matchId === '') {
    return res.status(400).json(errorEnvelope(ErrorCode.VALIDATION_ERROR, 'matchId is required'));
  }

  const match = store.getMatch(matchId);
  if (!match) {
    return res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'Match not found'));
  }

  if (!match.disputeDeadline) {
    logDisputeWindowEvent('dispute_rejected_outside_window', {
      matchId,
      reason: 'no_result_submitted',
    });
    return res
      .status(409)
      .json(
        errorEnvelope(
          ErrorCode.VALIDATION_ERROR,
          'No result has been submitted for this match; disputes are not yet available',
        ),
      );
  }

  if (!isDisputeWindowOpen(matchId)) {
    logDisputeWindowEvent('dispute_rejected_outside_window', {
      matchId,
      disputeDeadline: match.disputeDeadline,
    });
    return res
      .status(409)
      .json(
        errorEnvelope(
          ErrorCode.VALIDATION_ERROR,
          `Dispute window closed at ${match.disputeDeadline}`,
        ),
      );
  }

  const reason = typeof payload.reason === 'string' ? payload.reason : undefined;
  logDisputeWindowEvent('dispute_accepted', {
    matchId,
    disputeDeadline: match.disputeDeadline,
    reason,
  });

  return res.status(200).json({
    matchId,
    status: 'dispute_open',
    disputeDeadline: match.disputeDeadline,
  });
});

export default router;
