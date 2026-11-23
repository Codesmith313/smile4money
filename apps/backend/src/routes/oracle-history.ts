import { Router } from 'express';
import type { Request, Response } from 'express';
import type { EvidenceStore } from '../store/evidence-store.js';
import type { MatchStorePort } from '../store/match-store.js';
import { authenticate } from '../middleware/auth.js';
import { ErrorCode, errorEnvelope } from '../errors/errorResponse.js';

function parseDate(value: unknown, isEndDate: boolean): number | undefined | null {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T.+)?$/.test(value)) {
    return null;
  }

  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;

  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(timestamp).toISOString().slice(0, 10);
    if (date !== value) return null;
    return isEndDate ? timestamp + 86_400_000 - 1 : timestamp;
  }
  return timestamp;
}

function invalidQuery(res: Response, message: string) {
  return res.status(400).json(errorEnvelope(ErrorCode.VALIDATION_ERROR, message));
}

export function createOracleHistoryRouter(matches?: Pick<MatchStorePort, 'findByGameId' | 'listMatchesByPlayer'>, evidence?: Pick<EvidenceStore, 'query'>) {
  const router = Router();
  router.use(authenticate);

  router.get('/', async (req: Request, res: Response, next) => {
    const gameId = req.query.game_id;
    if (gameId !== undefined && (typeof gameId !== 'string' || gameId.trim().length === 0)) {
      return invalidQuery(res, 'game_id must be a non-empty string');
    }

    const startTime = parseDate(req.query.start_date, false);
    const endTime = parseDate(req.query.end_date, true);
    if (startTime === null) {
      return invalidQuery(res, 'start_date must be an ISO 8601 date or timestamp');
    }
    if (endTime === null) {
      return invalidQuery(res, 'end_date must be an ISO 8601 date or timestamp');
    }
    if (startTime !== undefined && endTime !== undefined && startTime > endTime) {
      return invalidQuery(res, 'start_date must be before or equal to end_date');
    }

    try {
      const stores = matches && evidence ? { matchStore: matches, evidenceStore: evidence } : await import('../store/index.js');
      const owner = req.address;
      if (!owner) {
        return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Authentication required'));
      }

      const options = { gameId, startTime, endTime };
      if (gameId) {
        const match = await stores.matchStore.findByGameId(gameId);
        if (!match || (match.player1.toLowerCase() !== owner.toLowerCase() && match.player2.toLowerCase() !== owner.toLowerCase())) {
          return res.status(404).json(errorEnvelope(ErrorCode.NOT_FOUND, 'History not found'));
        }

        const decisions = await stores.evidenceStore.query(options);
        return res.json({
          submissions: decisions.map((decision) => ({
            ...decision,
            decisionId: decision.id,
            provider: decision.evidence?.provider ?? match.platform,
          })),
        });
      }

      const playerMatches = await stores.matchStore.listMatchesByPlayer(owner);
      const matchById = new Map(playerMatches.map((match) => [match.matchId, match]));
      const decisions = await stores.evidenceStore.query({ startTime, endTime });
      return res.json({
        submissions: decisions
          .filter((decision) => matchById.has(decision.matchId))
          .map((decision) => ({
            ...decision,
            decisionId: decision.id,
            provider: decision.evidence?.provider ?? matchById.get(decision.matchId)!.platform,
          })),
      });
    } catch (error) {
      next(error);
    }
  });

  return router;
}

export default createOracleHistoryRouter();
