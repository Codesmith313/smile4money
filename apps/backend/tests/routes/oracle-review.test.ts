import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReviewRouter } from '../../src/routes/oracle-review.js';
import { MemoryEvidenceStore } from '../../src/store/evidence-store.js';

const token = (address: string) => jwt.sign({ address }, process.env.JWT_SECRET || 'test-secret');

describe('oracle review workflow', () => {
  let ledger: MemoryEvidenceStore;
  const app = () => {
    const server = express();
    server.use(express.json());
    server.use('/reviews', createReviewRouter(ledger));
    return server;
  };
  const adminHeader = {
    Authorization: `Bearer ${token('operator')}`,
  };

  beforeEach(async () => {
    vi.stubEnv('ORACLE_ADMIN_ADDRESSES', 'operator');
    ledger = new MemoryEvidenceStore();
    await ledger.append({
      matchId: 7,
      gameId: 'disputed-game',
      state: 'review_required',
      reason: 'Ambiguous provider outcome',
      recordedAt: '2025-01-01T10:00:00.000Z',
      evidence: {
        provider: 'lichess',
        fetchedAt: '2025-01-01T10:00:00.000Z',
        parserVersion: '2',
        responseHash: 'hash',
        source: 'https://lichess.org/game/export/disputed-game',
        outcome: null,
        endedAt: null,
      },
    });
    await ledger.append({
      matchId: 8,
      gameId: 'resolved-game',
      state: 'verified',
      reason: 'Result verified',
      recordedAt: '2025-01-01T11:00:00.000Z',
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('lists only unresolved reviews and returns review details to administrators', async () => {
    const server = app();
    const queue = await request(server).get('/reviews').set(adminHeader);
    expect(queue.status).toBe(200);
    expect(queue.body.reviews).toHaveLength(1);
    expect(queue.body.reviews[0]).toMatchObject({
      decisionId: 1,
      gameId: 'disputed-game',
      provider: 'lichess',
      state: 'review_required',
    });

    const details = await request(server).get('/reviews/disputed-game').set(adminHeader);
    expect(details.status).toBe(200);
    expect(details.body.review).toMatchObject({
      state: 'review_required',
      reason: 'Ambiguous provider outcome',
    });
    expect(details.body.history).toHaveLength(1);
  });

  it('records an accepted result, operator and reason, then removes the review from the queue', async () => {
    const server = app();
    const response = await request(server)
      .post('/reviews/disputed-game/decision')
      .set(adminHeader)
      .send({
        decision: 'accept',
        result: 'Player1Wins',
        reason: 'Provider evidence was independently confirmed',
      });

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      decisionId: 3,
      state: 'operator_decided',
      decision: { action: 'accept', result: 'Player1Wins' },
    });
    expect(await ledger.history('disputed-game')).toMatchObject([
      { state: 'review_required' },
      {
        state: 'operator_decided',
        operator: 'operator',
        reason: 'Provider evidence was independently confirmed',
        operatorDecision: { action: 'accept', result: 'Player1Wins' },
      },
    ]);
    expect((await request(server).get('/reviews').set(adminHeader)).body.reviews).toHaveLength(0);
    expect(
      (
        await request(server)
          .post('/reviews/disputed-game/decision')
          .set(adminHeader)
          .send({ decision: 'reject', reason: 'No longer disputed' })
      ).status,
    ).toBe(409);
  });

  it('supports rejecting a disputed result and validates decisions and access', async () => {
    const server = app();
    expect(
      (
        await request(server)
          .post('/reviews/disputed-game/rollback')
          .send({ reason: 'Retry' })
      ).status,
    ).toBe(401);
    expect(
      (
        await request(server)
          .post('/reviews/disputed-game/rollback')
          .set('Authorization', `Bearer ${token('player')}`)
          .send({ reason: 'Retry' })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(server)
          .post('/reviews/disputed-game/decision')
          .set(adminHeader)
          .send({ decision: 'accept', result: 'invalid', reason: 'Check' })
      ).status,
    ).toBe(400);

    const rejected = await request(server)
      .post('/reviews/disputed-game/decision')
      .set(adminHeader)
      .send({ decision: 'reject', reason: 'Evidence was inconclusive' });
    expect(rejected.status).toBe(201);
    expect((await ledger.history('disputed-game'))[1]).toMatchObject({
      state: 'operator_decided',
      operatorDecision: { action: 'reject' },
    });

    expect(
      (
        await request(server)
          .get('/reviews')
          .set('Authorization', `Bearer ${token('player')}`)
      ).status,
    ).toBe(403);
    expect((await request(server).get('/reviews/disputed-game')).status).toBe(401);
  });
});
