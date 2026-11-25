import express from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOracleValidationRouter } from '../../src/routes/oracle-validation.js';
import { verifyGameResult } from '../../src/services/oracle-service.js';
import type { EvidenceStore } from '../../src/store/evidence-store.js';
import type {
  MatchRecord,
  MatchStorePort,
} from '../../src/store/match-store.js';

const { findByGameIdMock, verifyGameResultMock } = vi.hoisted(() => ({
  findByGameIdMock: vi.fn(),
  verifyGameResultMock: vi.fn(),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticate: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const authorization = req.header('Authorization');
    if (!authorization) return res.status(401).end();
    next();
  },
  Permission: { SUBMIT_RESULTS: 'submit_results' },
  requirePermission:
    () =>
    (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction,
    ) => {
      if (req.header('Authorization') !== 'Bearer submit_results') {
        return res.status(403).end();
      }
      next();
    },
}));

vi.mock('../../src/store/index.js', () => ({
  matchStore: { findByGameId: findByGameIdMock },
  evidenceStore: {},
}));

vi.mock('../../src/services/oracle-service.js', () => ({
  verifyGameResult: verifyGameResultMock,
}));

const app = () => {
  const server = express();
  server.use(express.json());
  server.use(
    '/validate-result',
    createOracleValidationRouter({
      matchStore: {
        findByGameId: findByGameIdMock,
      } as unknown as MatchStorePort,
      evidenceStore: {} as EvidenceStore,
      verifyGameResult: verifyGameResultMock as typeof verifyGameResult,
    }),
  );
  return server;
};

const match: MatchRecord = {
  matchId: 0,
  player1: 'GPLAYER1',
  player2: 'GPLAYER2',
  player1Username: 'alice',
  player2Username: 'bob',
  stakeAmount: 1,
  token: 'XLM',
  gameId: 'game-1',
  platform: 'lichess',
  state: 'Completed',
};

const validInput = {
  matchId: 0,
  gameId: 'game-1',
  platform: 'lichess',
};

describe('POST /api/oracle/validate-result', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    findByGameIdMock.mockResolvedValue(match);
  });

  it('reports every invalid field and does not invoke verification', async () => {
    const response = await request(app())
      .post('/validate-result')
      .set('Authorization', 'Bearer submit_results')
      .send({ matchId: -1, gameId: '', platform: 'unknown' });

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      valid: false,
      gasConsumed: false,
      errors: [
        { field: 'matchId' },
        { field: 'gameId' },
        { field: 'platform' },
      ],
    });
    expect(verifyGameResultMock).not.toHaveBeenCalled();
  });

  it('runs game and match consistency checks without consuming gas', async () => {
    verifyGameResultMock.mockResolvedValue({
      ok: true,
      verified: true,
      matchId: 0,
      gameId: 'game-1',
      result: 'Player1Wins',
      provider: 'lichess',
      whitePlayer: 'alice',
      blackPlayer: 'bob',
      status: 'finished',
      message: 'Result verified',
    });

    const response = await request(app())
      .post('/validate-result')
      .set('Authorization', 'Bearer submit_results')
      .send(validInput);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      valid: true,
      gasConsumed: false,
      matchId: 0,
      gameId: 'game-1',
      result: 'Player1Wins',
    });
    expect(verifyGameResultMock).toHaveBeenCalledWith(
      expect.anything(),
      validInput,
      expect.anything(),
    );
  });

  it('rejects a game ID paired with the wrong match ID before provider verification', async () => {
    findByGameIdMock.mockResolvedValue({ ...match, matchId: 7 });

    const response = await request(app())
      .post('/validate-result')
      .set('Authorization', 'Bearer submit_results')
      .send(validInput);

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual([
      {
        field: 'matchId',
        message: 'Game game-1 is recorded for match 7, not 0',
      },
    ]);
    expect(verifyGameResultMock).not.toHaveBeenCalled();
  });

  it('rejects a platform that conflicts with the stored match', async () => {
    const response = await request(app())
      .post('/validate-result')
      .set('Authorization', 'Bearer submit_results')
      .send({ ...validInput, platform: 'chessdotcom', username: 'alice' });

    expect(response.status).toBe(400);
    expect(response.body.errors).toEqual([
      {
        field: 'platform',
        message: 'Game game-1 is recorded on lichess, not chessdotcom',
      },
    ]);
    expect(verifyGameResultMock).not.toHaveBeenCalled();
  });

  it('reports an unknown game as a detailed validation failure', async () => {
    findByGameIdMock.mockResolvedValue(null);

    const response = await request(app())
      .post('/validate-result')
      .set('Authorization', 'Bearer submit_results')
      .send(validInput);

    expect(response.status).toBe(404);
    expect(response.body.errors).toEqual([
      { field: 'gameId', message: 'No match is recorded for game game-1' },
    ]);
    expect(verifyGameResultMock).not.toHaveBeenCalled();
  });

  it('returns detailed consistency failures from result verification', async () => {
    verifyGameResultMock.mockResolvedValue({
      ok: false,
      status: 400,
      error: 'Match ID does not match game',
      details: 'Game game-1 is recorded for match 7, not 0',
    });

    const response = await request(app())
      .post('/validate-result')
      .set('Authorization', 'Bearer submit_results')
      .send(validInput);

    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({
      valid: false,
      gasConsumed: false,
      errors: [
        {
          field: 'result',
          message: 'Match ID does not match game',
          details: 'Game game-1 is recorded for match 7, not 0',
        },
      ],
    });
  });

  it('requires authentication', async () => {
    const response = await request(app())
      .post('/validate-result')
      .send(validInput);

    expect(response.status).toBe(401);
  });

  it('requires submit_results permission', async () => {
    const response = await request(app())
      .post('/validate-result')
      .set('Authorization', 'Bearer read_only')
      .send(validInput);

    expect(response.status).toBe(403);
  });
});
