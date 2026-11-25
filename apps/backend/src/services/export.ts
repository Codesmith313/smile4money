import type { Request } from 'express';

export type ExportFormat = 'csv' | 'json';

export const EXPORT_FORMATS: readonly ExportFormat[] = ['csv', 'json'];

export const CSV_COLUMNS = [
  'id',
  'matchId',
  'player1',
  'player2',
  'stakeAmount',
  'token',
  'gameId',
  'platform',
  'state',
  'status',
  'winner',
  'createdAt',
  'updatedAt',
] as const;

export type ExportRow = Record<string, unknown>;

export function parseFormat(value: unknown): ExportFormat | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/^\./, '').toLowerCase();
  if (normalized === 'text/csv' || normalized === 'csv') return 'csv';
  if (normalized === 'application/json' || normalized === 'json') return 'json';
  return undefined;
}

export function serializeMatch(match: unknown): ExportRow {
  const source = match as { toObject?: (options?: { virtuals?: boolean }) => Record<string, unknown> };
  const raw: Record<string, unknown> =
    typeof source?.toObject === 'function'
      ? source.toObject({ virtuals: true })
      : { ...(match as Record<string, unknown>) };

  const row: ExportRow = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === '__v') continue;
    row[key] = value instanceof Date ? value.toISOString() : value;
  }

  if (row._id !== undefined) {
    const id = String(row._id);
    row._id = id;
    if (row.id === undefined) row.id = id;
  }

  if (row.state === undefined && row.status !== undefined) row.state = row.status;
  if (row.status === undefined && row.state !== undefined) row.status = row.state;
  if (row.stakeAmount === undefined && row.stake !== undefined) row.stakeAmount = row.stake;
  if (row.stake === undefined && row.stakeAmount !== undefined) row.stake = row.stakeAmount;

  return row;
}

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);

  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCSV(matches: readonly unknown[]): string {
  const rows = matches.map(serializeMatch);
  const columns: string[] = [...CSV_COLUMNS];

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }

  const lines = [columns.join(',')];
  for (const row of rows) {
    lines.push(columns.map((column) => csvCell(row[column])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

export function toJSON(matches: readonly unknown[]): string {
  return JSON.stringify(matches.map(serializeMatch), null, 2);
}

type QueryParams = Request['query'];

function queryValue(query: QueryParams, keys: readonly string[]): unknown {
  for (const key of keys) {
    const value = query[key];
    if (value !== undefined && value !== '') return value;
  }
  return undefined;
}

function asStringList(value: unknown, splitCommas = false): string[] {
  const values = Array.isArray(value) ? value : [value];
  const strings = values
    .map((item) => (typeof item === 'string' || typeof item === 'number' ? String(item) : ''))
    .map((item) => item.trim())
    .filter(Boolean);

  return splitCommas ? strings.flatMap((item) => item.split(',').map((part) => part.trim())).filter(Boolean) : strings;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function equalsAny(values: string[]): Record<string, unknown> {
  return { $in: values.map((value) => new RegExp(`^${escapeRegex(value)}$`, 'i')) };
}

function dateFrom(value: string, bound: 'start' | 'end'): Date {
  const date = new Date(bound === 'start' && /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date filter: ${value}`);
  return date;
}

export function buildMatchFilter(address: string, query: QueryParams): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    $or: [
      { player1: address },
      { player2: address },
      { userId: address },
      { address },
      { playerAddress: address },
      { owner: address },
      { createdBy: address },
      { players: address },
    ],
  };

  const addAnd = (clause: Record<string, unknown>): void => {
    filter.$and = [...((filter.$and as unknown[]) ?? []), clause];
  };

  const status = asStringList(queryValue(query, ['status', 'state', 'result', 'outcome']), true);
  if (status.length) {
    addAnd({ $or: [{ state: equalsAny(status) }, { status: equalsAny(status) }] });
  }

  const platform = asStringList(queryValue(query, ['platform']), true);
  if (platform.length) filter.platform = equalsAny(platform);

  const gameId = asStringList(queryValue(query, ['gameId', 'game_id']));
  if (gameId.length) filter.gameId = equalsAny(gameId);

  const token = asStringList(queryValue(query, ['token']));
  if (token.length) filter.token = equalsAny(token);

  const winner = asStringList(queryValue(query, ['winner']));
  if (winner.length) filter.winner = equalsAny(winner);

  const matchId = queryValue(query, ['matchId', 'match_id']);
  if (matchId !== undefined && Number.isFinite(Number(matchId))) filter.matchId = Number(matchId);

  const player = queryValue(query, ['player', 'playerAddress']);
  if (typeof player === 'string' && player && player !== address) {
    addAnd({ $or: [{ player1: player }, { player2: player }, { userId: player }] });
  }

  const minStake = queryValue(query, ['minStake', 'stakeMin']);
  if (minStake !== undefined && Number.isFinite(Number(minStake))) {
    const minimum = Number(minStake);
    addAnd({ $or: [{ stakeAmount: { $gte: minimum } }, { stake: { $gte: minimum } }] });
  }

  const maxStake = queryValue(query, ['maxStake', 'stakeMax']);
  if (maxStake !== undefined && Number.isFinite(Number(maxStake))) {
    const maximum = Number(maxStake);
    addAnd({ $or: [{ stakeAmount: { $lte: maximum } }, { stake: { $lte: maximum } }] });
  }

  const from = queryValue(query, ['from', 'fromDate', 'dateFrom', 'createdFrom', 'startDate', 'start', 'after', 'createdAfter']);
  const to = queryValue(query, ['to', 'toDate', 'dateTo', 'createdTo', 'endDate', 'end', 'before', 'createdBefore']);
  const createdAt: Record<string, Date> = {};
  if (typeof from === 'string') createdAt.$gte = dateFrom(from, 'start');
  if (typeof to === 'string') createdAt.$lte = dateFrom(to, 'end');
  if (Object.keys(createdAt).length) filter.createdAt = createdAt;

  return filter;
}

export function parseLimit(value: unknown): number | undefined {
  if (value === undefined || value === '') return undefined;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 0) throw new Error('Invalid limit filter');
  return limit;
}
