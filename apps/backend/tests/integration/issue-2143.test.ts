import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

import { app } from '../../src/app';
import { Match } from '../../src/models/Match';

const PLAYER = 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OPPONENT = 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function makeToken(address = PLAYER): string {
  return jwt.sign({ address }, process.env.JWT_SECRET ?? 'test-secret', { expiresIn: '1h' });
}

async function failedMatch(overrides: Record<string, unknown> = {}) {
  return Match.create({
    matchId: 1,
    player1: PLAYER,
    player2: OPPONENT,
    gameId: 'failed-game-1',
    platform: 'lichess',
    state: 'Pending',
    stakeAmount: 100,
    token: 'XLM',
    submissionStatus: 'failed',
    submissionError: 'contract submission timed out',
    evidence: { gameId: 'failed-game-1', winner: PLAYER, moves: ['e4', 'e5'] },
    retryCount: 1,
    ...overrides,
  });
}

let mongod: MongoMemoryServer;

beforeAll(async () => {
  mongod = await MongoMemoryServer.create();
  await mongoose.connect(mongod.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongod.stop();
});

beforeEach(async () => {
  await Match.deleteMany({});
});

describe('POST /api/matches/:id/retry — failed submission retry (issue #2143)', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/matches/some-id/retry').send({});
    expect(res.status).toBe(401);
  });

  it('retries a failed submission, reusing evidence and updating the timestamp', async () => {
    const match = await failedMatch();
    await new Promise((resolve) => setTimeout(resolve, 15));
    const previousUpdatedAt = match.updatedAt?.getTime();

    const res = await request(app)
      .post(`/api/matches/${match.id}/retry`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ evidence: { winner: 'SHOULD-BE-IGNORED' } });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.retryCount).toBe(2);
    expect(res.body.lastRetryAt).toBeDefined();
    expect(res.body.evidence).toEqual({ gameId: 'failed-game-1', winner: PLAYER, moves: ['e4', 'e5'] });

    const updated = await Match.findById(match._id);
    expect(updated?.retryCount).toBe(2);
    expect(updated?.lastRetryAt).toBeDefined();
    expect(updated?.submissionStatus).toBe('retrying');
    expect(updated?.evidence).toEqual({ gameId: 'failed-game-1', winner: PLAYER, moves: ['e4', 'e5'] });
    expect(updated?.updatedAt?.getTime()).toBeGreaterThan(previousUpdatedAt ?? 0);
  });

  it('accepts match_id in the body and supports nested evidence', async () => {
    const match = await failedMatch({
      evidence: undefined,
      submission: {
        status: 'failed',
        evidence: { source: 'lichess', gameId: 'nested-game' },
        error: 'rpc unavailable',
      },
      gameId: 'nested-game',
    });

    const res = await request(app)
      .post('/api/submissions/retry')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ match_id: String(match._id) });

    expect(res.status).toBe(200);
    expect(res.body.retryCount).toBe(2);
    expect(res.body.evidence).toEqual({ source: 'lichess', gameId: 'nested-game' });

    const updated = await Match.findById(match._id);
    expect(updated?.submission?.retryCount).toBe(2);
  });

  it('tracks repeated retries', async () => {
    const match = await failedMatch({ retryCount: 0 });

    const first = await request(app)
      .post(`/api/matches/${match.matchId}/retry`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});
    const second = await request(app)
      .post(`/api/matches/${match.matchId}/retry`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(second.body.retryCount).toBe(2);

    const updated = await Match.findById(match._id);
    expect(updated?.retryCount).toBe(2);
    expect(updated?.retryHistory).toHaveLength(2);
    expect(updated?.submissionAttempts).toHaveLength(2);
  });

  it('returns 409 when the submission is not failed', async () => {
    const match = await failedMatch({ submissionStatus: 'completed', submissionError: undefined });

    const res = await request(app)
      .post(`/api/matches/${match.id}/retry`)
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/failed|retry/i), code: 'not_retryable' });

    const unchanged = await Match.findById(match._id);
    expect(unchanged?.retryCount).toBe(1);
  });

  it('returns 404 for an unknown match', async () => {
    const res = await request(app)
      .post('/api/matches/64b7f9c2c4f2e2a9a4b1c3d4/retry')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/not found/i), code: 'match_not_found' });
  });

  it('rejects a caller who is not a participant', async () => {
    const match = await failedMatch();

    const res = await request(app)
      .post(`/api/matches/${match.id}/retry`)
      .set('Authorization', `Bearer ${makeToken('GSTRANGERCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC')}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('unauthorized');
  });
});
