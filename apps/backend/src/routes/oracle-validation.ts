import { Router } from 'express';
import type { Request, Response } from 'express';
import {
  authenticate,
  Permission,
  requirePermission,
} from '../middleware/auth.js';
import { matchStore, evidenceStore } from '../store/index.js';
import {
  verifyGameResult,
  type SubmitResultInput,
} from '../services/oracle-service.js';
import { validateSubmitResultInputDetailed } from '../services/submit-result-validation.js';
import type { EvidenceStore } from '../store/evidence-store.js';
import type { MatchStorePort } from '../store/match-store.js';
import { errorToHttpStatus } from '../errors/errorToHttpStatus.js';
import {
  ErrorCode,
  errorEnvelope,
  statusToErrorCode,
  userFacingErrorMessage,
} from '../errors/errorResponse.js';

interface OracleValidationDependencies {
  matchStore: MatchStorePort;
  evidenceStore: EvidenceStore;
  verifyGameResult: typeof verifyGameResult;
}

export function createOracleValidationRouter(
  dependencies: OracleValidationDependencies = {
    matchStore,
    evidenceStore,
    verifyGameResult,
  },
) {
  const router = Router();
  router.use(authenticate);
  const submitResultPermission = requirePermission(Permission.SUBMIT_RESULTS);

  const validate = async (req: Request, res: Response) => {
    const errors = validateSubmitResultInputDetailed(req.body);
    if (errors.length > 0) {
      const message = 'Result submission validation failed';
      return res.status(400).json({
        valid: false,
        gasConsumed: false,
        errors,
        error: errorEnvelope(ErrorCode.VALIDATION_ERROR, message, {
          validationErrors: errors,
        }).error,
      });
    }

    const payload = req.body as SubmitResultInput;
    try {
      const match = await dependencies.matchStore.findByGameId(payload.gameId);
      if (!match) {
        const validationErrors = [
          {
            field: 'gameId',
            message: `No match is recorded for game ${payload.gameId}`,
          },
        ];
        const message = 'Match not found';
        return res.status(404).json({
          valid: false,
          gasConsumed: false,
          errors: validationErrors,
          error: errorEnvelope(ErrorCode.NOT_FOUND, message, {
            validationErrors,
          }).error,
        });
      }

      if (match.matchId !== payload.matchId) {
        const validationErrors = [
          {
            field: 'matchId',
            message: `Game ${payload.gameId} is recorded for match ${match.matchId}, not ${payload.matchId}`,
          },
        ];
        const message = 'Match ID does not match game';
        return res.status(400).json({
          valid: false,
          gasConsumed: false,
          errors: validationErrors,
          error: errorEnvelope(ErrorCode.VALIDATION_ERROR, message, {
            validationErrors,
          }).error,
        });
      }

      if (match.platform !== payload.platform) {
        const validationErrors = [
          {
            field: 'platform',
            message: `Game ${payload.gameId} is recorded on ${match.platform}, not ${payload.platform}`,
          },
        ];
        const message = 'Platform does not match game';
        return res.status(400).json({
          valid: false,
          gasConsumed: false,
          errors: validationErrors,
          error: errorEnvelope(ErrorCode.VALIDATION_ERROR, message, {
            validationErrors,
          }).error,
        });
      }

      const result = await dependencies.verifyGameResult(
        dependencies.matchStore,
        {
          matchId: payload.matchId,
          gameId: payload.gameId,
          platform: payload.platform,
          username:
            typeof payload.username === 'string' ? payload.username : undefined,
        },
        dependencies.evidenceStore,
      );

      if (!result.ok) {
        const message =
          result.status >= 500
            ? userFacingErrorMessage(result.status)
            : result.details
              ? `${result.error}: ${result.details}`
              : result.error;
        const validationErrors = [
          {
            field: 'result',
            message: result.status >= 500 ? message : result.error,
            ...(result.details && result.status < 500
              ? { details: result.details }
              : {}),
          },
        ];
        return res.status(result.status).json({
          valid: false,
          gasConsumed: false,
          errors: validationErrors,
          error: errorEnvelope(statusToErrorCode(result.status), message, {
            validationErrors,
          }).error,
        });
      }

      return res.status(200).json({
        valid: true,
        gasConsumed: false,
        matchId: result.matchId,
        gameId: result.gameId,
        result: result.result,
        provider: result.provider,
        whitePlayer: result.whitePlayer,
        blackPlayer: result.blackPlayer,
        status: result.status,
      });
    } catch (error) {
      const status = errorToHttpStatus(error);
      const message = userFacingErrorMessage(status);
      const validationErrors = [{ field: 'result', message }];
      return res.status(status).json({
        valid: false,
        gasConsumed: false,
        errors: validationErrors,
        error: errorEnvelope(statusToErrorCode(status), message, {
          validationErrors,
        }).error,
      });
    }
  };
  router.post('/', submitResultPermission, validate);

  return router;
}

export default createOracleValidationRouter();
