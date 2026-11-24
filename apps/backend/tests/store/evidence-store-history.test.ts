import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SqliteEvidenceStore } from '../../src/store/evidence-store.js';

let directory: string;
let store: SqliteEvidenceStore;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-history-'));
  store = new SqliteEvidenceStore(path.join(directory, 'evidence.db'));
  await store.initialize();
});

afterEach(async () => {
  await store.close();
  await fs.rm(directory, { recursive: true });
});

describe('SQLite evidence history query', () => {
  it('filters by game ID and inclusive timestamps while retaining decision IDs', async () => {
    for (const [gameId, recordedAt] of [
      ['game-1', '2025-01-01T00:00:00.000Z'],
      ['game-1', '2025-01-02T12:00:00.000Z'],
      ['game-2', '2025-01-02T12:00:00.000Z'],
    ]) {
      await store.append({
        matchId: 1,
        gameId,
        state: 'verified',
        reason: 'Result verified',
        recordedAt,
      });
    }

    const decisions = await store.query({
      gameId: 'game-1',
      startTime: Date.parse('2025-01-02T00:00:00.000Z'),
      endTime: Date.parse('2025-01-02T23:59:59.999Z'),
    });

    expect(decisions).toMatchObject([{ id: 2, gameId: 'game-1', recordedAt: '2025-01-02T12:00:00.000Z' }]);
  });
});
