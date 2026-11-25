import mongoose from 'mongoose';

import { Match, type MatchRecord } from '../models/Match';
import { validateMatchInput, type MatchInput, type ValidationIssue } from './validation';

export type BatchFailureCode = 'invalid_batch' | 'invalid_match' | 'duplicate_in_batch' | 'duplicate_existing';

export interface BatchFailure {
  index: number;
  gameId?: string;
  field?: string;
  message: string;
  code: BatchFailureCode;
  errors?: ValidationIssue[];
}

export interface BatchValidationResult {
  ok: boolean;
  inputs: MatchInput[];
  failures: BatchFailure[];
}

export const MAX_BATCH_SIZE = 100;

export function validateBatch(raw: unknown, address: string, existingGameIds: readonly string[] = []): BatchValidationResult {
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      inputs: [],
      failures: [{ index: -1, message: 'Request body must be an array of matches', code: 'invalid_batch' }],
    };
  }
  if (raw.length === 0) {
    return {
      ok: false,
      inputs: [],
      failures: [{ index: -1, message: 'Batch must contain at least one match', code: 'invalid_batch' }],
    };
  }
  if (raw.length > MAX_BATCH_SIZE) {
    return {
      ok: false,
      inputs: [],
      failures: [
        { index: -1, message: `Batch cannot contain more than ${MAX_BATCH_SIZE} matches`, code: 'invalid_batch' },
      ],
    };
  }

  const failures: BatchFailure[] = [];
  const inputs: MatchInput[] = [];
  const seen = new Map<string, number>();
  const existing = new Set(existingGameIds.map((id) => id.toLowerCase()));

  raw.forEach((item, index) => {
    const result = validateMatchInput(item, address);
    if (!result.ok) {
      failures.push({
        index,
        message: result.errors.map((error) => error.message).join('; '),
        code: 'invalid_match',
        errors: result.errors,
        field: result.errors[0]?.field,
      });
      return;
    }

    const gameId = result.value.gameId;
    const key = gameId.toLowerCase();
    if (seen.has(key)) {
      failures.push({
        index,
        gameId,
        message: `gameId "${gameId}" is duplicated in this batch (first used at index ${seen.get(key)})`,
        code: 'duplicate_in_batch',
        field: 'gameId',
      });
      return;
    }
    seen.set(key, index);

    if (existing.has(key)) {
      failures.push({
        index,
        gameId,
        message: `A match with gameId "${gameId}" already exists`,
        code: 'duplicate_existing',
        field: 'gameId',
      });
      return;
    }

    inputs.push(result.value);
  });

  return { ok: failures.length === 0, inputs, failures };
}

export async function findExistingGameIds(gameIds: readonly string[]): Promise<string[]> {
  if (!gameIds.length) return [];
  const matches = await Match.find({ gameId: { $in: [...gameIds] } }).select('gameId').lean().exec();
  return matches.flatMap((match) => (typeof match.gameId === 'string' ? [match.gameId] : []));
}

function buildDocuments(inputs: readonly MatchInput[], address: string, startId: number): MatchRecord[] {
  return inputs.map((input, offset) => ({
    matchId: startId + offset,
    player1: address,
    player2: input.player2,
    stakeAmount: input.stakeAmount,
    token: input.token,
    gameId: input.gameId,
    platform: input.platform,
    state: 'Pending',
  }));
}

function supportsTransactions(): boolean {
  const connection = mongoose.connection as unknown as {
    client?: { topology?: { description?: { type?: string } } };
  };
  const type = connection.client?.topology?.description?.type;
  return Boolean(type && type !== 'Single' && type !== 'Unknown');
}

async function insertWithTransaction(documents: MatchRecord[]): Promise<MatchRecord[]> {
  const session = await mongoose.startSession();
  try {
    session.startTransaction();
    const created = await Match.create(documents, { session });
    await session.commitTransaction();
    return created as MatchRecord[];
  } catch (error) {
    if (session.inTransaction()) await session.abortTransaction();
    throw error;
  } finally {
    await session.endSession();
  }
}

async function insertWithCompensation(documents: MatchRecord[]): Promise<MatchRecord[]> {
  const created: MatchRecord[] = [];
  try {
    for (const document of documents) {
      created.push(await Match.create(document));
    }
    return created;
  } catch (error) {
    if (created.length) {
      const ids = created.map((match) => (match as MatchRecord & { _id?: unknown })._id);
      await Match.deleteMany({ _id: { $in: ids } });
    }
    throw error;
  }
}

export async function createMatchesAtomically(inputs: readonly MatchInput[], address: string): Promise<MatchRecord[]> {
  const startId = (await Match.countDocuments({})) + 1;
  const documents = buildDocuments(inputs, address, startId);

  if (supportsTransactions()) return insertWithTransaction(documents);

  return insertWithCompensation(documents);
}
