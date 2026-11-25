import { Router, type Request, type Response } from 'express';

import { requireAuth, type AuthenticatedRequest } from '../middleware/auth';
import { serializeMatch } from '../services/export';
import { retryFailedSubmission, SubmissionRetryError } from '../services/submission';

export const submissionsRouter = Router();

function playerAddress(req: Request): string {
  return (req as AuthenticatedRequest).playerAddress ?? '';
}

function identifierFrom(req: Request): unknown {
  const body = (req.body ?? {}) as Record<string, unknown>;
  return (
    req.params.matchId ??
    req.params.match_id ??
    body.match_id ??
    body.matchId ??
    body.id
  );
}

async function retrySubmission(req: Request, res: Response): Promise<void> {
  try {
    const result = await retryFailedSubmission(identifierFrom(req), playerAddress(req));
    const match = serializeMatch(result.match);
    const timestamp = result.match.lastRetryAt ?? result.match.retriedAt;

    res.status(200).json({
      ...match,
      success: true,
      match,
      evidence: result.evidence,
      receipt: result.receipt,
      retryCount: result.retryCount,
      retry_count: result.retryCount,
      lastRetryAt: timestamp,
      retriedAt: result.match.retriedAt ?? timestamp,
      submissionStatus: result.match.submissionStatus,
      status: result.match.submissionStatus ?? result.match.state ?? result.match.status,
    });
  } catch (error) {
    if (error instanceof SubmissionRetryError) {
      res.status(error.status).json({ error: error.message, code: error.code });
      return;
    }
    const message = error instanceof Error ? error.message : 'Unable to retry submission';
    res.status(500).json({ error: message, code: 'retry_failed' });
  }
}

submissionsRouter.use(requireAuth);
submissionsRouter.post('/:matchId/retry-submission', retrySubmission);
submissionsRouter.post('/:matchId/retry', retrySubmission);
submissionsRouter.patch('/:matchId/retry', retrySubmission);
submissionsRouter.post('/retry', retrySubmission);
submissionsRouter.post('/', retrySubmission);

export const retrySubmissionHandler = retrySubmission;
export default submissionsRouter;
