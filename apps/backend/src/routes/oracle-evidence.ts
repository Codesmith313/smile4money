import { Router } from 'express';
import { authenticate } from '../middleware/auth.js';
import { ErrorCode, errorEnvelope } from '../errors/errorResponse.js';
import {
  buildEvidenceBundle,
  EvidenceNotFoundError,
  type EvidenceDeps,
} from '../services/dispute-evidence.js';
import type { MatchRecord } from '../store/match-store.js';

async function getEvidenceDeps(): Promise<EvidenceDeps> {
  const [{ matchStore }, queue] = await Promise.all([
    import('../store/index.js'),
    import('../queue.js'),
  ]);
  return {
    findMatch: (gameId) => matchStore.findByGameId(gameId),
    listDlqEntries: queue.listDlqEntries,
    fetchProviderResult: async (match: MatchRecord) => {
      if (match.platform === 'lichess') {
        const { fetchLichessResult } = await import('../fetchers/lichess.js');
        return fetchLichessResult(match.gameId);
      }
      if (match.platform === 'chessdotcom') {
        if (!match.player1Username) {
          throw new Error(
            'match has no recorded Chess.com username to search archives with',
          );
        }
        const { fetchChessDotComResult } =
          await import('../fetchers/chessdotcom.js');
        return fetchChessDotComResult(match.player1Username, match.gameId);
      }
      throw new Error(`unknown platform ${match.platform}`);
    },
    network: process.env.STELLAR_NETWORK ?? 'testnet',
    escrowContractId: process.env.CONTRACT_ESCROW,
    oracleContractId: process.env.CONTRACT_ORACLE,
  };
}

export function createOracleEvidenceRouter(deps?: EvidenceDeps) {
  const router = Router();
  router.use(authenticate);
  router.use((req, res, next) => {
    const operators = (process.env.ORACLE_ADMIN_ADDRESSES ?? '')
      .split(',')
      .map((address) => address.trim().toLowerCase())
      .filter(Boolean);
    if (!req.address || !operators.includes(req.address.toLowerCase())) {
      return res
        .status(403)
        .json(
          errorEnvelope(
            ErrorCode.FORBIDDEN,
            'Administrator access is required.',
          ),
        );
    }
    next();
  });

  router.get('/', async (req, res, next) => {
    const gameId = req.query.game_id;
    if (typeof gameId !== 'string' || gameId.trim().length === 0) {
      return res
        .status(400)
        .json(
          errorEnvelope(
            ErrorCode.VALIDATION_ERROR,
            'game_id must be a non-empty string',
          ),
        );
    }

    try {
      const evidence = await buildEvidenceBundle(
        gameId.trim(),
        deps ?? (await getEvidenceDeps()),
      );
      return res.json(evidence);
    } catch (error) {
      if (error instanceof EvidenceNotFoundError) {
        return res
          .status(404)
          .json(
            errorEnvelope(ErrorCode.NOT_FOUND, 'Evidence could not be found.'),
          );
      }
      next(error);
    }
  });

  return router;
}

export default createOracleEvidenceRouter();
