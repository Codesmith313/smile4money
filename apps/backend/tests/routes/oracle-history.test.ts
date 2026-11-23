import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createOracleHistoryRouter } from '../../src/routes/oracle-history.js';
import { MemoryEvidenceStore } from '../../src/store/evidence-store.js';
import { MatchStore } from '../../src/store/match-store.js';

const token = (address: string) => jwt.sign({ address }, process.env.JWT_SECRET || 'test-secret');

describe('GET /api/oracle/history', () => {
  it("returns all of the player's decisions with provider and decision ID", async () => {
    const matches = new MatchStore();
    await matches.createMatch({
      player1: 'G1',
      player2: 'G2',
      gameId: 'game-1',
      platform: 'lichess',
      stakeAmount: 10,
      token: 'XLM',
    });
    const evidence = new MemoryEvidenceStore();
    await evidence.append({
      matchId: 0,
      gameId: 'game-1',
      state: 'verified',
      reason: 'Result verified',
      recordedAt: '2025-01-03T12:00:00.000Z',
      evidence: {
        provider: 'lichess',
        fetchedAt: '2025-01-03T11:59:00.000Z',
        parserVersion: '2',
        responseHash: 'abc',
        source: 'https://lichess.org/game/export/game-1',
        outcome: 'Player1Wins',
        endedAt: '2025-01-03T11:58:00.000Z',
      },
    });
    await evidence.append({
      matchId: 0,
      gameId: 'game-1',
      state: 'retry_requested',
      reason: 'Recheck',
      recordedAt: '2025-01-04T12:00:00.000Z',
    });

    const app = express();
    app.use('/history', createOracleHistoryRouter(matches, evidence));
    const response = await request(app)
      .get('/history')
      .set('Authorization', `Bearer ${token('G1')}`);

    expect(response.status).toBe(200);
    expect(response.body.submissions).toHaveLength(2);
    expect(response.body.submissions[0]).toMatchObject({
      decisionId: 1,
      provider: 'lichess',
      state: 'verified',
    });
    expect(response.body.submissions[1]).toMatchObject({
      decisionId: 2,
      provider: 'lichess',
      state: 'retry_requested',
    });
  });

  it('filters by game and inclusive date bounds, and hides other players’ history', async () => {
    const matches = new MatchStore();
    await matches.createMatch({
      player1: 'G1',
      player2: 'G2',
      gameId: 'game-1',
      platform: 'lichess',
      stakeAmount: 10,
      token: 'XLM',
    });
    await matches.createMatch({
      player1: 'G3',
      player2: 'G4',
      gameId: 'game-2',
      platform: 'chessdotcom',
      stakeAmount: 10,
      token: 'XLM',
    });
    const evidence = new MemoryEvidenceStore();
    for (const [matchId, gameId, recordedAt] of [
      [0, 'game-1', '2025-01-01T00:00:00.000Z'],
      [0, 'game-1', '2025-01-02T12:00:00.000Z'],
      [1, 'game-2', '2025-01-02T12:00:00.000Z'],
    ] as const) {
      await evidence.append({
        matchId,
        gameId,
        state: 'verified',
        reason: 'Result verified',
        recordedAt,
      });
    }

    const app = express();
    app.use('/history', createOracleHistoryRouter(matches, evidence));
    const response = await request(app)
      .get('/history?game_id=game-1&start_date=2025-01-02&end_date=2025-01-02')
      .set('Authorization', `Bearer ${token('g1')}`);

    expect(response.status).toBe(200);
    expect(response.body.submissions).toHaveLength(1);
    expect(response.body.submissions[0]).toMatchObject({
      decisionId: 2,
      provider: 'lichess',
    });
    const allHistory = await request(app)
      .get('/history')
      .set('Authorization', `Bearer ${token('G1')}`);
    expect(allHistory.body.submissions).toHaveLength(2);
    expect(
      (
        await request(app)
          .get('/history?game_id=game-2')
          .set('Authorization', `Bearer ${token('G1')}`)
      ).status,
    ).toBe(404);
  });

  it('rejects malformed or reversed date ranges', async () => {
    const app = express();
    app.use('/history', createOracleHistoryRouter(new MatchStore(), new MemoryEvidenceStore()));
    const headers = { Authorization: `Bearer ${token('G1')}` };
    expect((await request(app).get('/history?start_date=bad').set(headers)).status).toBe(400);
    expect((await request(app).get('/history?start_date=2025-02-01&end_date=2025-01-01').set(headers)).status).toBe(400);
  });
});
