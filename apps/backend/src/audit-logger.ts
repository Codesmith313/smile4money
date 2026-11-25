import { logger } from './logger';

export interface AuthContext {
  ip?: string;
  path?: string;
  [key: string]: unknown;
}

const SAFE_CONTEXT_FIELDS = ['ip', 'path'] as const;

function sanitizeContext(context?: AuthContext): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  if (!context) {
    return safe;
  }
  for (const field of SAFE_CONTEXT_FIELDS) {
    const value = context[field];
    if (value !== undefined) {
      safe[field] = value;
    }
  }
  return safe;
}

export function logAuthSuccess(userId: string, context?: AuthContext): void {
  logger.info('auth_success', {
    user_id: userId,
    ...sanitizeContext(context),
  });
}

export function logAuthFailure(reason: string, context?: AuthContext): void {
  logger.warn('auth_failure', {
    reason,
    ...sanitizeContext(context),
  });
}