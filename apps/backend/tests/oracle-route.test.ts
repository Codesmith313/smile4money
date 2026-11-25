/**
 * Tests for the oracle /submit-result route.
 *
 * Focused on the match-not-found paths, specifically distinguishing between:
 * - gameId unknown but store has other records (regular 404)
 * - store completely empty (persistence-loss suspected 404)
 */

import request from 'supertest';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import oracleRouter from '../src/routes/oracle.js';
import { matchStore } from '../src/store/index.js';
import jwt from 'jsonwebtoken';
import axios from 'axios';

vi.mock('axios');
vi.mock('../src/store/index.js', async () => {
  const { MatchStore } = await import('../src/store/match-store.js');
  return { matchStore: new MatchStore() };
});

const secret = process.env.JWT_SECRET || 'test-secret';
const makeToken = (address = 'GORACLE1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA') =>
  jwt.sign({ address }, secret, { expiresIn: '1h' });

const createApp = () => {
  const app = express();
  app.use(express.json());
  app.use('/api/oracle', oracleRouter);
  return app;
};

const VALID_BODY = {
  matchId: 1,
  gameId: 'lichess-game-abc123',
  platform: 'lichess',
};

beforeEach(() => {
  matchStore.clear();
  vi.restoreAllMocks();
});

describe('POST /api/oracle/submit-result — match not found', () => {
  it('returns 404 with a generic message when gameId is unknown but store has records', async () => {
    // Seed a different match so the store is non-empty
    await matchStore.createMatch({
      player1: 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player2: 'GPLAYER2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player1Username: 'alice',
      player2Username: 'bob',
      stakeAmount: 100,
      token: 'XLM',
      gameId: 'some-other-game',
      platform: 'lichess',
    });

    const res = await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    // #50 — standard { error: { code, message } } envelope; the previous
    // separate `details` field is folded into error.message, and `hint`
    // (when present) lives at error.hint, not at the top level.
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toContain('Match not found');
    expect(res.body.error.message).toContain('lichess-game-abc123');
    // Must NOT carry the persistence-loss hint
    expect(res.body.error.hint).toBeUndefined();
  });

  it('returns 404 with a persistence-loss hint when the store is empty', async () => {
    // Store is already empty from beforeEach
    const res = await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('NOT_FOUND');
    expect(res.body.error.message).toContain('Match not found');
    expect(res.body.error.hint).toBe('persistence_loss_suspected');
    expect(res.body.error.message).toMatch(/server may have restarted/i);
    expect(res.body.error.message).toMatch(/QUEUE_STORE/i);
  });

  it('logs oracle_match_not_found_empty_store at error level when store is empty', async () => {
    const logSpy = vi.spyOn(console, 'log');

    await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    const loggedMessages = logSpy.mock.calls
      .flatMap((args) => args)
      .map((arg) => {
        try { return JSON.parse(arg as string); } catch { return null; }
      })
      .filter(Boolean);

    const entry = loggedMessages.find(
      (m) => m.message === 'oracle_match_not_found_empty_store',
    );
    expect(entry).toBeDefined();
    expect(entry.level).toBe('error');
    expect(entry.game_id).toBe('lichess-game-abc123');
    expect(entry.store_count).toBe(0);
  });

  it('logs oracle_match_not_found at warn level when store has records', async () => {
    await matchStore.createMatch({
      player1: 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player2: 'GPLAYER2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player1Username: 'alice',
      player2Username: 'bob',
      stakeAmount: 100,
      token: 'XLM',
      gameId: 'some-other-game',
      platform: 'lichess',
    });

    const logSpy = vi.spyOn(console, 'log');

    await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    const loggedMessages = logSpy.mock.calls
      .flatMap((args) => args)
      .map((arg) => {
        try { return JSON.parse(arg as string); } catch { return null; }
      })
      .filter(Boolean);

    const entry = loggedMessages.find(
      (m) => m.message === 'oracle_match_not_found',
    );
    expect(entry).toBeDefined();
    expect(entry.level).toBe('warn');
    expect(entry.store_count).toBe(1);
  });
});

// matchId must be validated as a non-negative safe integer before any
// downstream processing (store lookup, chess-platform API calls, Stellar
// transaction building).
describe('POST /api/oracle/submit-result — matchId validation', () => {
  it('returns 200 for a valid positive-integer matchId', async () => {
    await matchStore.createMatch({
      player1: 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player2: 'GPLAYER2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player1Username: 'alice',
      player2Username: 'bob',
      stakeAmount: 100,
      token: 'XLM',
      gameId: VALID_BODY.gameId,
      platform: 'lichess',
    });

    const res = await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    expect(res.status).not.toBe(400);
  });

  it.each([
    ['non-numeric string', 'not-a-number'],
    ['a float', 1.5],
    ['unsafe integer', Number.MAX_SAFE_INTEGER + 1],
    ['negative', -1],
  ])('returns 400 when matchId is %s', async (_label, matchId) => {
    const res = await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...VALID_BODY, matchId });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.message).toBe('matchId must be a non-negative safe integer');
  });

  it('verifies the first match through HTTP with identifier zero', async () => {
    const match = await matchStore.createMatch({
      player1: 'p1', player2: 'p2', player1Username: 'alice', player2Username: 'bob',
      stakeAmount: 1, token: 'XLM', gameId: VALID_BODY.gameId, platform: 'lichess',
    });
    expect(match.matchId).toBe(0);
    vi.mocked(axios.get).mockResolvedValueOnce({ status: 200, data: {
      id: VALID_BODY.gameId, status: 'mate', winner: 'white',
      createdAt: 1700000000000, lastMoveAt: 1700000060000,
      players: { white: { user: { name: 'alice' } }, black: { user: { name: 'bob' } } },
    } });
    const res = await request(createApp()).post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`).send({ ...VALID_BODY, matchId: 0 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ verified: true, matchId: 0, result: 'Player1Wins' });
  });

  it('rejects an invalid matchId before touching the match store', async () => {
    const countSpy = vi.spyOn(matchStore, 'findByGameId');

    await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ ...VALID_BODY, matchId: -5 });

    expect(countSpy).not.toHaveBeenCalled();
  });
});

// #2115 — dispute window enforcement. Submitting a result opens a dispute
// window; challenges are only accepted while that window is open.
describe('POST /api/oracle/submit-result — dispute window', () => {
  const seedMatch = async () =>
    matchStore.createMatch({
      player1: 'GPLAYER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player2: 'GPLAYER2AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      player1Username: 'alice',
      player2Username: 'bob',
      stakeAmount: 100,
      token: 'XLM',
      gameId: VALID_BODY.gameId,
      platform: 'lichess',
    });

  const mockLichessGame = () => {
    vi.mocked(axios.get).mockResolvedValueOnce({
      status: 200,
      data: {
        id: VALID_BODY.gameId,
        status: 'mate',
        winner: 'white',
        createdAt: 1700000000000,
        lastMoveAt: 1700000060000,
        players: {
          white: { user: { name: 'alice' } },
          black: { user: { name: 'bob' } },
        },
      },
    });
  };

  const parseLogs = (logSpy: ReturnType<typeof vi.spyOn>) =>
    logSpy.mock.calls
      .flatMap((args) => args)
      .map((arg) => {
        try { return JSON.parse(arg as string); } catch { return null; }
      })
      .filter(Boolean);

  it('opens a dispute window when the result is submitted', async () => {
    const match = await seedMatch();
    mockLichessGame();

    const res = await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    expect(res.status).toBe(200);

    const stored = await matchStore.getMatch(match.matchId);
    expect(stored?.disputeWindow).toBeDefined();
    expect(stored?.disputeWindow?.openedAt).toBeDefined();
    expect(stored?.disputeWindow?.expiresAt).toBeGreaterThan(
      stored!.disputeWindow!.openedAt,
    );
  });

  it('logs dispute_window_opened when the result is submitted', async () => {
    await seedMatch();
    mockLichessGame();
    const logSpy = vi.spyOn(console, 'log');

    await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    const entry = parseLogs(logSpy).find(
      (m) => m.message === 'dispute_window_opened',
    );
    expect(entry).toBeDefined();
    expect(entry.game_id).toBe(VALID_BODY.gameId);
    expect(entry.match_id).toBe(0);
  });

  it('rejects a dispute submitted after the window has expired', async () => {
    const match = await seedMatch();
    mockLichessGame();

    await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    // Force the window closed by moving its expiry into the past.
    const stored = await matchStore.getMatch(match.matchId);
    await matchStore.updateMatch(match.matchId, {
      disputeWindow: {
        ...stored!.disputeWindow!,
        expiresAt: Date.now() - 1,
      },
    });

    const logSpy = vi.spyOn(console, 'log');

    const res = await request(createApp())
      .post('/api/oracle/dispute')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ matchId: match.matchId, reason: 'wrong winner' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('DISPUTE_WINDOW_CLOSED');

    const entry = parseLogs(logSpy).find(
      (m) => m.message === 'dispute_window_expired',
    );
    expect(entry).toBeDefined();
    expect(entry.match_id).toBe(match.matchId);
  });

  it('accepts a dispute submitted within the window', async () => {
    const match = await seedMatch();
    mockLichessGame();

    await request(createApp())
      .post('/api/oracle/submit-result')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send(VALID_BODY);

    const res = await request(createApp())
      .post('/api/oracle/dispute')
      .set('Authorization', `Bearer ${makeToken()}`)
      .send({ matchId: match.matchId, reason: 'wrong winner' });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ matchId: match.matchId, disputed: true });
  });
});
