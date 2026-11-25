import { Router, type Request, type Response } from 'express';
import type { FilterQuery } from 'mongoose';

import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { Match, type MatchRecord } from '../models/Match';
import {
  buildMatchFilter,
  parseFormat,
  parseLimit,
  serializeMatch,
  toCSV,
  toJSON,
  type ExportFormat,
} from '../services/export';

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

    const body = (req.body ?? {}) as Record<string, unknown>;
    const address = playerAddress(req);
    const { player2, stakeAmount, token, gameId, platform } = body;

    if (typeof player2 !== 'string' || !player2.trim()) {
      res.status(400).json({ error: 'player2 is required' });
      return;
    }
    if (typeof stakeAmount !== 'number' || !Number.isSafeInteger(stakeAmount) || stakeAmount <= 0) {
      res.status(400).json({ error: 'stakeAmount must be a positive safe integer' });
      return;
    }
    if (typeof token !== 'string' || !token.trim()) {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    if (typeof gameId !== 'string' || !gameId.trim()) {
      res.status(400).json({ error: 'gameId is required' });
      return;
    }
    if (gameId.length > 128) {
      res.status(400).json({ error: 'gameId is too long' });
      return;
    }
    if (!/^[A-Za-z0-9._-]+$/.test(gameId)) {
      res.status(400).json({ error: 'gameId contains invalid characters' });
      return;
    }
    if (typeof platform !== 'string' || !['lichess', 'chessdotcom', 'chess.com'].includes(platform.toLowerCase())) {
      res.status(400).json({ error: 'platform must be lichess or chessdotcom' });
      return;
    }
    if (player2 === address) {
      res.status(400).json({ error: 'A player cannot create a match against themselves' });
      return;
    }

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

matchesRouter.use(requireAuth);
matchesRouter.get('/export', exportMatches);
matchesRouter.get('/export.:format', exportMatches);
matchesRouter.get('/export/:format', exportMatches);
matchesRouter.get('/history/export', exportMatches);
matchesRouter.get('/history/export.:format', exportMatches);
matchesRouter.get('/history', exportMatches);
matchesRouter.get('/history.:format', exportMatches);
matchesRouter.get('/', listMatches);
matchesRouter.post('/', createMatch);

export const exportMatchesHandler = exportMatches;
export default matchesRouter;
