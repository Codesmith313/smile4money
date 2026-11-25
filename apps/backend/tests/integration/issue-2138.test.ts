import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import mongoose from 'mongoose';
import jwt from 'jsonwebtoken';

import { app } from '../../src/app';
import { Match } from '../../src/models/Match';

const PLAYER = 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const OTHER_PLAYER = 'GPLAYER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

function makeToken(address = PLAYER): string {
  return jwt.sign({ address }, process.env.JWT_SECRET ?? 'test-secret', { expiresIn: '1h' });
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

async function seedMatch(overrides: Record<string, unknown> = {}) {
  return Match.create({
    matchId: 1,
    player1: PLAYER,
    player2: OTHER_PLAYER,
    stakeAmount: 100,
    token: 'XLM',
    gameId: 'lichess-game-1',
    platform: 'lichess',
    state: 'Completed',
    createdAt: new Date('2026-01-15T12:00:00.000Z'),
    ...overrides,
  });
}

describe('GET /api/matches/export — match history export (issue #2138)', () => {
  it('returns 401 without a valid token', async () => {
    const missing = await request(app).get('/api/matches/export');
    expect(missing.status).toBe(401);

    const malformed = await request(app)
      .get('/api/matches/export')
      .set('Authorization', 'Bearer this.is.not.valid');
    expect(malformed.status).toBe(401);
  });

  it('exports JSON by default with download headers and only the caller matches', async () => {
    await seedMatch();
    await seedMatch({ matchId: 2, gameId: 'chesscom-game-2', player1: OTHER_PLAYER, player2: PLAYER });

    const res = await request(app)
      .get('/api/matches/export')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('matches.json');
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body).toHaveLength(2);
    expect(res.body.map((match: { gameId: string }) => match.gameId).sort()).toEqual([
      'chesscom-game-2',
      'lichess-game-1',
    ]);
  });

  it('exports CSV with a header row, escaped values and download headers', async () => {
    await seedMatch({ gameId: 'lichess,game,with,commas', platform: 'lichess' });

    const res = await request(app)
      .get('/api/matches/export?format=csv')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('matches.csv');
    expect(res.text).toContain('gameId');
    expect(res.text).toContain('"lichess,game,with,commas"');
    expect(res.text).toContain(PLAYER);
    expect(res.text).toContain('2026-01-15T12:00:00.000Z');
  });

  it('applies status and platform filters before exporting', async () => {
    await seedMatch({ matchId: 1, gameId: 'game-completed', state: 'Completed', platform: 'lichess' });
    await seedMatch({ matchId: 2, gameId: 'game-pending', state: 'Pending', platform: 'lichess' });
    await seedMatch({ matchId: 3, gameId: 'game-chesscom', state: 'Completed', platform: 'chesscom' });

    const res = await request(app)
      .get('/api/matches/export?format=json&status=Completed&platform=lichess')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({ gameId: 'game-completed' });
  });

  it('applies date-range and gameId filters before exporting', async () => {
    await seedMatch({ matchId: 1, gameId: 'old-game', createdAt: new Date('2025-12-31T00:00:00.000Z') });
    await seedMatch({ matchId: 2, gameId: 'wanted-game', createdAt: new Date('2026-01-15T00:00:00.000Z') });
    await seedMatch({ matchId: 3, gameId: 'future-game', createdAt: new Date('2026-03-01T00:00:00.000Z') });

    const res = await request(app)
      .get('/api/matches/export?format=csv&from=2026-01-01&to=2026-02-01&gameId=wanted-game')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.text).toContain('wanted-game');
    expect(res.text).not.toContain('old-game');
    expect(res.text).not.toContain('future-game');
  });

  it('supports export format in the path and a limit filter', async () => {
    await seedMatch({ matchId: 1, gameId: 'game-one' });
    await seedMatch({ matchId: 2, gameId: 'game-two' });

    const res = await request(app)
      .get('/api/matches/export/json?limit=1')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
  });

  it('returns 400 for an unsupported format', async () => {
    const res = await request(app)
      .get('/api/matches/export?format=xml')
      .set('Authorization', `Bearer ${makeToken()}`);

    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/format/i) });
  });
});
