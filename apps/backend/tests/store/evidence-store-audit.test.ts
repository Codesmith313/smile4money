import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  SqliteEvidenceStore,
  type Decision,
} from '../../src/store/evidence-store.js';

describe('SQLite operator decision audit trail', () => {
  let directory: string | undefined;
  let ledger: SqliteEvidenceStore | undefined;

  afterEach(async () => {
    if (ledger) await ledger.close();
    if (directory) await fs.rm(directory, { recursive: true });
  });

  it('requires operator, reason, and ISO timestamp and persists them', async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'evidence-audit-'));
    ledger = new SqliteEvidenceStore(path.join(directory, 'evidence.db'));
    await ledger.initialize();

    const decision: Decision = {
      matchId: 1,
      gameId: 'game',
      state: 'retry_requested',
      reason: 'Provider corrected evidence',
      operator: 'operator-address',
      recordedAt: new Date().toISOString(),
    };

    await expect(
      ledger.append({ ...decision, operator: undefined }),
    ).rejects.toThrow('Operator identity is required');
    await expect(ledger.append({ ...decision, reason: ' ' })).rejects.toThrow(
      'Decision reason is required',
    );
    await expect(
      ledger.append({ ...decision, recordedAt: 'not-a-timestamp' }),
    ).rejects.toThrow('valid ISO 8601 timestamp is required');

    const id = await ledger.append(decision);
    await expect(ledger.history('game')).resolves.toEqual([
      { ...decision, id },
    ]);
  });
});
