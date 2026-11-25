import { Router, type Request, type Response } from 'express';
import type { FilterQuery } from 'mongoose';

import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { Match, type MatchRecord } from '../models/Match';
import {
  createMatchesAtomically,
  findExistingGameIds,
  validateBatch,
  type BatchFailure,
} from '../services/batch';
import {
  buildMatchFilter,
  parseFormat,
  parseLimit,
  serializeMatch,
  toCSV,
  toJSON,
  type ExportFormat,
} from '../services/export';
import { validateMatchInput } from '../services/validation';

export const matchesRouter = Router();

function playerAddress(req: Request): string {
  return (req as AuthenticatedRequest).playerAddress ?? '';
}

function failure(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : 'Unable to export matches';
  res.status(400).json({ error: message });
}

function filterFor(req: Request): FilterQuery<MatchRecord> {
  return buildMatchFilter(playerAddress(req), req.query) as FilterQuery<MatchRecord>;
}

function limitFor(req: Request): number | undefined {
  return parseLimit(req.query.limit ?? req.query.maxResults);
}

async function findMatches(req: Request): Promise<MatchRecord[]> {
  let query = Match.find(filterFor(req)).sort({ createdAt: -1, _id: 1 });
  const limit = limitFor(req);
  if (limit !== undefined) query = query.limit(limit);
  return (await query.lean().exec()) as MatchRecord[];
}

async function exportMatches(req: Request, res: Response): Promise<void> {
  try {
    const requested = req.params.format ?? req.query.format ?? req.query.type;
    let format: ExportFormat = 'json';

    if (requested !== undefined) {
      const parsed = parseFormat(requested);
      if (!parsed) {
        res.status(400).json({ error: 'Unsupported format. Use csv or json.' });
        return;
      }
      format = parsed;
    } else if ((req.get('accept') ?? '').includes('text/csv')) {
      format = 'csv';
    }

    const matches = await findMatches(req);
    res.setHeader('Content-Disposition', `attachment; filename="matches.${format}"`);
    res.setHeader('X-Total-Count', String(matches.length));

    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.status(200).send(toCSV(matches));
      return;
    }

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.status(200).send(toJSON(matches));
  } catch (error) {
    failure(res, error);
  }
}

async function listMatches(req: Request, res: Response): Promise<void> {
  try {
    const matches = await findMatches(req);
    res.status(200).json(matches.map(serializeMatch));
  } catch (error) {
    failure(res, error);
  }
}

async function createMatch(req: Request, res: Response): Promise<void> {
  try {
    if (!req.is('application/json')) {
      res.status(400).json({ error: 'Content-Type must be application/json' });
      return;
    }

    const address = playerAddress(req);
    const result = validateMatchInput(req.body, address);
    if (!result.ok) {
      res.status(400).json({ error: result.errors[0].message, errors: result.errors });
      return;
    }
    const { player2, stakeAmount, token, gameId, platform } = result.value;

    if (await Match.exists({ gameId })) {
      res.status(409).json({ error: 'A match with this gameId already exists' });
      return;
    }

    const matchId = (await Match.countDocuments({})) + 1;
    const created = await Match.create({
      matchId,
      player1: address,
      player2,
      stakeAmount,
      token,
      gameId,
      platform,
      state: 'Pending',
    });

    res.status(201).json(serializeMatch(created));
  } catch (error) {
    failure(res, error);
  }
}

function rejectBatch(res: Response, failures: BatchFailure[]): void {
  const duplicatesOnly = failures.every(
    (item) => item.code === 'duplicate_in_batch' || item.code === 'duplicate_existing',
  );
  const details = failures.map((item) => ({
    ...item,
    error: item.message,
    matchIndex: item.index,
  }));
  res.status(duplicatesOnly ? 409 : 400).json({
    error: `Batch rejected: ${failures.length} match(es) failed validation`,
    created: 0,
    failed: failures.length,
    failedCount: failures.length,
    failedIndices: failures.map((item) => item.index),
    failures: details,
    errors: details,
    details,
    results: details,
    matches: [],
    length: 0,
  });
}

async function createBatchMatches(req: Request, res: Response): Promise<void> {
  try {
    if (!req.is('application/json')) {
      res.status(400).json({ error: 'Content-Type must be application/json' });
      return;
    }

    const address = playerAddress(req);
    const body = req.body as { matches?: unknown } | unknown[] | null | undefined;
    const batchBody = Array.isArray(body) ? body : body?.matches;
    const initial = validateBatch(batchBody, address);
    if (!initial.ok && initial.failures.some((item) => item.code === 'invalid_batch')) {
      rejectBatch(res, initial.failures);
      return;
    }

    const existing = await findExistingGameIds(initial.inputs.map((input) => input.gameId));
    const validation = validateBatch(batchBody, address, existing);
    if (!validation.ok) {
      rejectBatch(res, validation.failures);
      return;
    }

    const created = await createMatchesAtomically(validation.inputs, address);
    const matches = created.map(serializeMatch);
    const response: Record<string, unknown> = {
      created: matches.length,
      count: matches.length,
      failed: 0,
      failedCount: 0,
      failedIndices: [],
      failures: [],
      errors: [],
      results: matches,
      matches,
      createdMatches: matches,
      data: matches,
      length: matches.length,
    };
    matches.forEach((match, index) => {
      response[index] = match;
    });

    res.status(201).json(response);
  } catch (error) {
    failure(res, error);
  }
}

matchesRouter.use(requireAuth);
matchesRouter.get('/export', exportMatches);
matchesRouter.get('/export.:format', exportMatches);
matchesRouter.get('/export/:format', exportMatches);
matchesRouter.get('/history/export', exportMatches);
matchesRouter.get('/history/export.:format', exportMatches);
matchesRouter.get('/history', exportMatches);
matchesRouter.get('/history.:format', exportMatches);
matchesRouter.get('/', listMatches);
matchesRouter.post('/batch', createBatchMatches);
matchesRouter.post('/bulk', createBatchMatches);
matchesRouter.post('/create-many', createBatchMatches);
matchesRouter.post('/', createMatch);

export const exportMatchesHandler = exportMatches;
export const createBatchMatchesHandler = createBatchMatches;
export default matchesRouter;
