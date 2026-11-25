import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOracleEvidenceRouter } from '../../src/routes/oracle-evidence.js';
import type { EvidenceDeps } from '../../src/services/dispute-evidence.js';
import type { MatchRecord } from '../../src/store/match-store.js';

vi.mock('../../src/middleware/auth.js', () => ({
  authenticate: (
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    const authorization = req.header('Authorization');
    if (!authorization?.startsWith('Bearer ')) return res.status(401).end();
    req.address = authorization.slice('Bearer '.length);
    next();
  },
}));

const match: MatchRecord = {
  matchId: 7,
  player1: 'GAPLAYERONEADDRESS',
  player2: 'GAPPLAYERTWOADDRESS',
  stakeAmount: 1_000_000,
  token: 'CTOKENCONTRACT',
  gameId: 'game-7',
  platform: 'lichess',
  state: 'Completed',
};

function makeDeps(): EvidenceDeps {
  return {
    findMatch: async (gameId) => (gameId === match.gameId ? match : null),
    listDlqEntries: async () => [],
    fetchProviderResult: async () => ({
      gameId: match.gameId,
      status: 'mate',
      whitePlayer: 'white',
      blackPlayer: 'black',
      result: 'Player1Wins',
    }),
    network: 'testnet',
    escrowContractId: 'CESCROW',
    oracleContractId: 'CORACLE',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
  };
}

describe('GET /api/oracle/evidence', () => {
  beforeEach(() => {
    vi.stubEnv('ORACLE_ADMIN_ADDRESSES', 'operator');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns evidence and provider data for the requested game_id to an operator', async () => {
    const app = express();
    app.use('/evidence', createOracleEvidenceRouter(makeDeps()));

    const response = await request(app)
      .get('/evidence?game_id=game-7')
      .set('Authorization', 'Bearer operator');

    expect(response.status).toBe(200);
    expect(response.body.match).toMatchObject({ gameId: 'game-7', matchId: 7 });
    expect(response.body.provider.lookup).toMatchObject({
      status: 'ok',
      gameStatus: 'mate',
      result: 'Player1Wins',
    });
    expect(response.body.ledger).toMatchObject({
      network: 'testnet',
      escrowContractId: 'CESCROW',
      oracleContractId: 'CORACLE',
    });
  });

  it('requires an operator token and a game_id', async () => {
    const app = express();
    app.use('/evidence', createOracleEvidenceRouter(makeDeps()));

    expect((await request(app).get('/evidence?game_id=game-7')).status).toBe(
      401,
    );
    expect(
      (
        await request(app)
          .get('/evidence?game_id=game-7')
          .set('Authorization', 'Bearer player')
      ).status,
    ).toBe(403);
    expect(
      (
        await request(app)
          .get('/evidence')
          .set('Authorization', 'Bearer operator')
      ).status,
    ).toBe(400);
  });

  it('returns not found for a game without a recorded match', async () => {
    const app = express();
    app.use('/evidence', createOracleEvidenceRouter(makeDeps()));

    const response = await request(app)
      .get('/evidence?game_id=unknown')
      .set('Authorization', 'Bearer operator');

    expect(response.status).toBe(404);
  });
});
