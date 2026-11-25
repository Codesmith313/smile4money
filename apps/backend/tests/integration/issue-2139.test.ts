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

function matchPayload(index: number, overrides: Record<string, unknown> = {}) {
  return {
    player2: OPPONENT,
    stakeAmount: 100 + index,
    token: 'XLM',
    gameId: `batch-game-${index}`,
    platform: 'lichess',
    ...overrides,
  };
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

describe('POST /api/matches/batch — atomic batch creation (issue #2139)', () => {
  it('requires authentication', async () => {
    const res = await request(app).post('/api/matches/batch').send([matchPayload(1)]);
    expect(res.status).toBe(401);
  });

  it('accepts an array and creates every match in one request', async () => {
    const res = await request(app)
      .post('/api/matches/batch')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send([matchPayload(1), matchPayload(2), matchPayload(3)]);

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(3);
    expect(res.body.matches).toHaveLength(3);
    expect(res.body.length).toBe(3);
    expect(res.body[0]).toMatchObject({ gameId: 'batch-game-1', state: 'Pending' });
    expect(await Match.countDocuments({})).toBe(3);
  });

  it('reports the failing index with details and creates nothing on validation failure', async () => {
    const res = await request(app)
      .post('/api/matches/batch')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send([matchPayload(1), matchPayload(2, { stakeAmount: -5 }), matchPayload(3)]);

    expect(res.status).toBe(400);
    expect(res.body.created).toBe(0);
    expect(res.body.failed).toBe(1);
    expect(res.body.failedIndices).toEqual([1]);
    expect(res.body.errors[0]).toMatchObject({
      index: 1,
      field: 'stakeAmount',
      code: 'invalid_match',
    });
    expect(await Match.countDocuments({})).toBe(0);
  });

  it('rejects duplicate gameIds inside the batch without partial writes', async () => {
    const res = await request(app)
      .post('/api/matches/batch')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send([matchPayload(1), matchPayload(2, { gameId: 'batch-game-1' })]);

    expect(res.status).toBe(409);
    expect(res.body.failures[0]).toMatchObject({ index: 1, code: 'duplicate_in_batch' });
    expect(await Match.countDocuments({})).toBe(0);
  });

  it('rejects batches colliding with persisted matches', async () => {
    await Match.create(matchPayload(1));

    const res = await request(app)
      .post('/api/matches/batch')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send([matchPayload(2), matchPayload(1)]);

    expect(res.status).toBe(409);
    expect(res.body.failures[0]).toMatchObject({ index: 1, code: 'duplicate_existing' });
    expect(await Match.countDocuments({})).toBe(1);
  });

  it('rejects empty and non-array payloads with a clear error', async () => {
    const empty = await request(app)
      .post('/api/matches/batch')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send([]);
    expect(empty.status).toBe(400);
    expect(empty.body.errors[0]).toMatchObject({ code: 'invalid_batch' });

    const object = await request(app)
      .post('/api/matches/batch')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ matches: 'not-an-array' });
    expect(object.status).toBe(400);
    expect(await Match.countDocuments({})).toBe(0);
  });

  it('accepts a matches wrapper object', async () => {
    const res = await request(app)
      .post('/api/matches/batch')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ matches: [matchPayload(5)] });

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
    expect(await Match.countDocuments({})).toBe(1);
  });

  it('supports the bulk alias', async () => {
    const res = await request(app)
      .post('/api/matches/bulk')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send([matchPayload(7)]);

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(1);
  });
});
