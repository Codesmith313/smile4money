import { Router } from 'express';
import type { MatchResult } from '../fetchers/lichess.js';
import { authenticate } from '../middleware/auth.js';
import {
  withGameLock,
  type EvidenceStore,
  type OperatorDecision,
} from '../store/evidence-store.js';
import { ErrorCode, errorEnvelope } from '../errors/errorResponse.js';
import logger from '../logger.js';

const VALID_RESULTS = new Set(['Player1Wins', 'Player2Wins', 'Draw']);

function isMatchResult(value: unknown): value is Exclude<MatchResult, null> {
  return typeof value === 'string' && VALID_RESULTS.has(value);
}

function isAwaitingReview(state: string): boolean {
  return state === 'review_required' || state === 'retry_requested';
}

export function createReviewRouter(ledger?: EvidenceStore) {
  const router = Router();
  const getLedger = async () => ledger ?? (await import('../store/index.js')).evidenceStore;

  router.use(authenticate);
  router.use((req, res, next) => {
    const operators = (process.env.ORACLE_ADMIN_ADDRESSES ?? '')
      .split(',')
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean);
    if (!req.address || !operators.includes(req.address.toLowerCase())) {
      return res
        .status(403)
        .json(errorEnvelope(ErrorCode.FORBIDDEN, 'Administrator access is required.'));
    }
    next();
  });

  router.get('/', async (_req, res, next) => {
    try {
      const decisions = await (await getLedger()).query();
      const latestByGame = new Map<string, (typeof decisions)[number]>();
      for (const decision of decisions) {
        const latest = latestByGame.get(decision.gameId);
        if (!latest || (decision.id ?? 0) > (latest.id ?? 0)) {
          latestByGame.set(decision.gameId, decision);
        }
      }

      const reviews = [...latestByGame.values()]
        .filter((decision) => isAwaitingReview(decision.state))
        .sort(
          (left, right) =>
            left.recordedAt.localeCompare(right.recordedAt) || (left.id ?? 0) - (right.id ?? 0),
        )
        .map((decision) => ({
          decisionId: decision.id,
          matchId: decision.matchId,
          gameId: decision.gameId,
          state: decision.state,
          reason: decision.reason,
          recordedAt: decision.recordedAt,
          provider: decision.evidence?.provider ?? null,
          evidence: decision.evidence,
        }));
      return res.json({ reviews });
    } catch (error) {
      next(error);
    }
  });

  router.get('/:gameId', async (req, res, next) => {
    try {
      const history = await (await getLedger()).history(req.params.gameId);
      if (!history.length) {
        return res
          .status(404)
          .json(errorEnvelope(ErrorCode.NOT_FOUND, 'Evidence could not be found.'));
      }
      return res.json({ review: history[history.length - 1], history });
    } catch (error) {
      next(error);
    }
  });

  router.post('/:gameId/decision', async (req, res, next) => {
    const body = req.body;
    const validKeys =
      body &&
      typeof body === 'object' &&
      Object.keys(body).every((key) => ['decision', 'result', 'reason'].includes(key));
    const decision: OperatorDecision | undefined =
      body?.decision === 'accept' && isMatchResult(body.result)
        ? {
            action: 'accept',
            result: body.result,
          }
        : body?.decision === 'reject' && body.result === undefined
          ? { action: 'reject' }
          : undefined;
    if (
      !validKeys ||
      !decision ||
      typeof body.reason !== 'string' ||
      !body.reason.trim() ||
      body.reason.length > 500
    ) {
      return res
        .status(400)
        .json(
          errorEnvelope(
            ErrorCode.VALIDATION_ERROR,
            'Provide an accept decision with a valid result, or a reject decision, and a reason between 1 and 500 characters.',
          ),
        );
    }

    try {
      const decisionId = await withGameLock(req.params.gameId, async () => {
        const store = await getLedger();
        const history = await store.history(req.params.gameId);
        const latest = history[history.length - 1];
        if (!latest || !isAwaitingReview(latest.state)) return null;
        return store.append({
          matchId: latest.matchId,
          gameId: latest.gameId,
          state: 'operator_decided',
          reason: body.reason.trim(),
          operator: req.address,
          operatorDecision: decision,
          recordedAt: new Date().toISOString(),
        });
      });
      if (decisionId === null) {
        return res
          .status(409)
          .json(errorEnvelope(ErrorCode.CONFLICT, 'The match is not awaiting review.'));
      }

      logger.info(
        {
          game_id: req.params.gameId,
          decision_id: decisionId,
          operator: req.address,
          decision,
          reason: body.reason.trim(),
        },
        'oracle_review_decision_recorded',
      );
      return res.status(201).json({
        decisionId,
        state: 'operator_decided',
        decision,
      });
    } catch (error) {
      next(error);
    }
  });

  // Only permit re-fetching evidence. No winner override, transaction signing or contract call.
  router.post('/:gameId/retry', async (req, res, next) => {
    if (
      !req.body ||
      Object.keys(req.body).some((key) => key !== 'reason') ||
      typeof req.body.reason !== 'string' ||
      !req.body.reason.trim() ||
      req.body.reason.length > 500
    ) {
      return res
        .status(400)
        .json(
          errorEnvelope(
            ErrorCode.VALIDATION_ERROR,
            'Provide only a reason between 1 and 500 characters.',
          ),
        );
    }
    try {
      const decisionId = await withGameLock(req.params.gameId, async () => {
        const store = await getLedger();
        const history = await store.history(req.params.gameId);
        const latest = history[history.length - 1];
        if (!latest || !isAwaitingReview(latest.state)) return null;
        return store.append({
          matchId: latest.matchId,
          gameId: latest.gameId,
          state: 'retry_requested',
          reason: req.body.reason.trim(),
          evidence: latest.evidence,
          operator: req.address,
          recordedAt: new Date().toISOString(),
        });
      });
      if (decisionId === null) {
        return res
          .status(409)
          .json(errorEnvelope(ErrorCode.CONFLICT, 'The match is not awaiting review.'));
      }
      return res.json({ decisionId, state: 'retry_requested' });
    } catch (error) {
      next(error);
    }
  });
  return router;
}

export default createReviewRouter();
