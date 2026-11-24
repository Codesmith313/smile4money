import { unlinkPlayerIdentities } from '../services/player-identity.js';
import { Router } from 'express';
import { matchStore } from '../store/index.js';
import { authenticate } from '../middleware/auth.js';
import {
  validateCreateMatchInput,
  createMatchForPlayer,
  searchMatches,
  getMatchStatistics,
} from '../services/match-service.js';
import {
  ErrorCode,
  errorEnvelope,
  statusToErrorCode,
  userFacingErrorMessage,
} from '../errors/errorResponse.js';

const router = Router();
const store = matchStore;

router.use(authenticate);

router.delete('/identities', async (req, res, next) => {
  try {
    await unlinkPlayerIdentities(store, req.address!);
    return res.status(204).end();
  } catch (err) {
    next(err);
  }
});

router.get('/statistics', async (req, res) => {
  const player =
    typeof req.query.player === 'string' ? req.query.player : undefined;

  const result = await getMatchStatistics(store, { player });

  if (!result.ok) {
    return res
      .status(result.status)
      .json(errorEnvelope(statusToErrorCode(result.status), result.error));
  }

  return res.status(200).json(result.statistics);
});

router.get('/', async (req, res) => {
  const result = await searchMatches(store, req.query);

  if (!result.ok) {
    return res
      .status(result.status)
      .json(errorEnvelope(statusToErrorCode(result.status), result.error));
  }

  return res.status(200).json({
    matches: result.matches,
    nextCursor: result.nextCursor,
  });
});

router.post('/', async (req, res) => {
  const payload = req.body;
  const player1 = req.address;

  if (!player1) {
    return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Authentication required'));
  }

  if (!payload || typeof payload !== 'object') {
    return res
      .status(400)
      .json(
        errorEnvelope(ErrorCode.VALIDATION_ERROR, 'Request body must be JSON'),
      );
  }

  if (!req.address) {
    return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Authenticated wallet address is required'));
  }

  // Validate input fields before calling the service
  const validationError = validateCreateMatchInput(player1, payload);
  if (validationError) {
    return res
      .status(400)
      .json(errorEnvelope(ErrorCode.VALIDATION_ERROR, validationError));
  }

  const result = await createMatchForPlayer(store, player1, {
    player2: payload.player2,
    stakeAmount: payload.stakeAmount,
    token: payload.token,
    gameId: payload.gameId,
    platform: payload.platform,
    username:
      typeof payload.username === 'string' ? payload.username : undefined,
  });

  if (!result.ok) {
    const message =
      result.status >= 500
        ? userFacingErrorMessage(result.status)
        : result.details
          ? `${result.error}: ${result.details}`
          : result.error;
    return res
      .status(result.status)
      .json(errorEnvelope(statusToErrorCode(result.status), message));
  }

  return res.status(201).json(result.match);
});

export default router;
