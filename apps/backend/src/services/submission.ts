import type { HydratedDocument } from 'mongoose';

import { Match, type MatchRecord } from '../models/Match';
import { submitResult, type SubmissionReceipt } from './contract';

type MatchDocument = HydratedDocument<MatchRecord>;

export class SubmissionRetryError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
  }
}

export interface RetryResult {
  match: MatchDocument;
  evidence: unknown;
  retryCount: number;
  receipt?: SubmissionReceipt;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function evidenceFor(match: MatchRecord): unknown {
  const submission = asRecord(match.submission);
  const resultSubmission = asRecord(match.resultSubmission);
  const candidates = [
    match.evidence,
    submission?.evidence,
    resultSubmission?.evidence,
    submission?.payload,
    resultSubmission?.payload,
    submission?.data,
    resultSubmission?.data,
    submission?.result,
    resultSubmission?.result,
    match.result,
    match.winner,
    match.gameId,
  ];

  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    if (typeof candidate === 'string' && candidate.trim()) return candidate;
    if (typeof candidate === 'object' && Object.keys(asRecord(candidate) ?? {}).length) return candidate;
  }
  return undefined;
}

export function isRetryableSubmission(match: MatchRecord): boolean {
  const submission = asRecord(match.submission);
  const resultSubmission = asRecord(match.resultSubmission);
  const statuses = [
    match.submissionStatus,
    match.status,
    match.state,
    submission?.status,
    resultSubmission?.status,
  ];

  if (statuses.some((status) => typeof status === 'string' && /failed|retry/i.test(status))) return true;
  return Boolean(
    match.submissionError ||
      match.lastError ||
      submission?.error ||
      resultSubmission?.error ||
      submission?.lastError ||
      resultSubmission?.lastError,
  );
}

export async function findMatchForRetry(identifier: unknown): Promise<MatchDocument | null> {
  const id = String(identifier ?? '').trim();
  if (!id) return null;

  if (/^[0-9a-fA-F]{24}$/.test(id)) {
    const found = await Match.findById(id);
    if (found) return found;
  }

  const numericId = Number(id);
  const alternatives: Record<string, unknown>[] = [{ gameId: id }];
  if (Number.isFinite(numericId)) alternatives.push({ matchId: numericId });

  return Match.findOne({ $or: alternatives });
}

export async function retryFailedSubmission(identifier: unknown, address?: string): Promise<RetryResult> {
  const match = await findMatchForRetry(identifier);
  if (!match) {
    throw new SubmissionRetryError('Match not found', 404, 'match_not_found');
  }

  const participants = [match.player1, match.player2].filter(Boolean);
  if (address && participants.length && !participants.includes(address)) {
    throw new SubmissionRetryError('Unauthorized: not a participant in this match', 403, 'unauthorized');
  }

  if (!isRetryableSubmission(match)) {
    throw new SubmissionRetryError('Only failed result submissions can be retried', 409, 'not_retryable');
  }

  const evidence = evidenceFor(match);
  if (evidence === undefined) {
    throw new SubmissionRetryError('No stored evidence is available for this submission', 422, 'evidence_missing');
  }

  const now = new Date();
  const submission = asRecord(match.submission);
  const resultSubmission = asRecord(match.resultSubmission);
  const previousCount = Number(
    match.retryCount ?? match.retry_count ?? submission?.retryCount ?? resultSubmission?.retryCount ?? 0,
  );
  const retryCount = (Number.isFinite(previousCount) ? previousCount : 0) + 1;
  const attempt = { at: now.toISOString(), status: 'retrying', evidence, retriedBy: address };

  match.retryCount = retryCount;
  match.retry_count = retryCount;
  match.submissionStatus = 'retrying';
  match.lastRetryAt = now;
  match.retriedAt = now;
  match.lastAttemptAt = now;
  match.retryHistory = [...(match.retryHistory ?? []), attempt];
  match.submissionAttempts = [...(match.submissionAttempts ?? []), attempt];

  if (submission) {
    match.submission = {
      ...submission,
      status: 'retrying',
      retryCount,
      lastAttemptAt: now.toISOString(),
      lastRetryAt: now.toISOString(),
      evidence,
    };
  }
  if (resultSubmission) {
    match.resultSubmission = {
      ...resultSubmission,
      status: 'retrying',
      retryCount,
      lastAttemptAt: now.toISOString(),
      lastRetryAt: now.toISOString(),
      evidence,
    };
  }

  let receipt: SubmissionReceipt | undefined;
  try {
    receipt = await submitResult(evidence);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Contract submission failed';
    match.submissionError = message;
    match.lastError = message;
    await match.save();
    throw new SubmissionRetryError(message, 502, 'submission_failed');
  }

  match.submissionError = undefined;
  match.lastError = undefined;
  await match.save();

  return { match, evidence, retryCount, receipt };
}
