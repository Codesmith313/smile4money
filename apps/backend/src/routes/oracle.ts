import { Router } from 'express';
import { matchStore, evidenceStore } from '../store/index.js';
import { authenticate } from '../middleware/auth.js';
import { requirePermission, requireSignature } from '../middleware/permissions.js';
import { Permission } from '../permissions.js';
import { validateSubmitResultInput, verifyGameResult } from '../services/oracle-service.js';
import {
  getOracleConfig,
  updateOracleConfig,
  validateOracleConfigInput,
} from '../services/oracle-config-service.js';
import { getDashboardMetrics } from '../services/oracle-metrics.js';
import { errorToHttpStatus } from '../errors/errorToHttpStatus.js';
import {
  errorEnvelope,
  ErrorCode,
  statusToErrorCode,
  userFacingErrorMessage,
} from '../errors/errorResponse.js';

const router = Router();
const store = matchStore;

// Oracle endpoints require authentication
router.use(authenticate);

/**
 * Admin allowlist for oracle configuration endpoints. Configured via the
 * `ORACLE_ADMIN_ADDRESSES` env var as a comma-separated list of addresses.
 * When unset, no caller is treated as an admin (fail closed).
 */
function getAdminAllowlist(): Set<string> {
  const raw = process.env.ORACLE_ADMIN_ADDRESSES ?? '';
  return new Set(
    raw
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}

function isAdmin(req: { user?: { address?: string } }): boolean {
  const address = req.user?.address;
  if (!address) return false;
  return getAdminAllowlist().has(address);
}

/**
 * GET /api/oracle/config
 *
 * Returns the current oracle configuration with credentials redacted.
 * Admin only.
 */
router.get('/config', (req, res) => {
  if (!isAdmin(req as { user?: { address?: string } })) {
    return res
      .status(403)
      .json(errorEnvelope(ErrorCode.FORBIDDEN, 'Admin access required'));
  }

  return res.status(200).json({ config: getOracleConfig() });
});

/**
 * PUT /api/oracle/config
 *
 * Update provider credentials and endpoints. Admin only.
 *
 * Request body may contain any subset of:
 * ```json
 * {
 *   "endpoints": { "lichess": "https://...", "chesscom": "https://..." },
 *   "credentials": { "lichess": "token", "chesscom": "token" }
 * }
 * ```
 */
router.put('/config', (req, res) => {
  if (!isAdmin(req as { user?: { address?: string } })) {
    return res
      .status(403)
      .json(errorEnvelope(ErrorCode.FORBIDDEN, 'Admin access required'));
  }

  const payload = req.body;
  if (!payload || typeof payload !== 'object') {
    return res
      .status(400)
      .json(errorEnvelope(ErrorCode.VALIDATION_ERROR, 'Request body must be JSON'));
  }

  const inputError = validateOracleConfigInput(payload);
  if (inputError) {
    return res
      .status(400)
      .json(errorEnvelope(ErrorCode.VALIDATION_ERROR, inputError));
  }

  try {
    const updated = updateOracleConfig(payload, {
      actor: (req as { user?: { address?: string } }).user?.address ?? 'unknown',
    });
    return res.status(200).json({ config: updated });
  } catch (error) {
    const status = errorToHttpStatus(error);
    return res
      .status(status)
      .json(errorEnvelope(statusToErrorCode(status), userFacingErrorMessage(status)));
  }
});

/**
 * GET /api/oracle/dashboard
 *
 * Aggregated oracle performance metrics for monitoring dashboards:
 * submissions/hour, success rate, and per-operation latency percentiles.
 */
router.get('/dashboard', (_req, res) => {
  try {
    return res.status(200).json(getDashboardMetrics());
  } catch (error) {
    const status = errorToHttpStatus(error);
    return res
      .status(status)
      .json(errorEnvelope(statusToErrorCode(status), userFacingErrorMessage(status)));
  }
});

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

export default router;
