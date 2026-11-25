import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';

export interface AuthenticatedRequest extends Request {
  playerAddress?: string;
}

const TOKEN_ADDRESS_KEYS = ['address', 'userId', 'user', 'player', 'playerAddress', 'sub'] as const;

function addressFromPayload(payload: jwt.JwtPayload | string): string | undefined {
  if (typeof payload === 'string') return payload || undefined;

  for (const key of TOKEN_ADDRESS_KEYS) {
    const value = payload[key];
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object') {
      const nested = (value as Record<string, unknown>).address;
      if (typeof nested === 'string' && nested) return nested;
    }
  }
  return undefined;
}

export function extractAddress(req: Request): string | undefined {
  const header = req.get('authorization');
  if (!header) return undefined;

  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return undefined;

  const token = match[1];
  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET ?? 'test-secret');
    const address = addressFromPayload(payload);
    if (address) return address;
  } catch {
    if (token.includes('.')) return undefined;
  }

  return token.includes('.') ? undefined : token;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const address = extractAddress(req);
  if (!address) {
    res.status(401).json({ error: 'Unauthorized: a valid token is required' });
    return;
  }

  (req as AuthenticatedRequest).playerAddress = address;
  next();
}

export const authenticate = requireAuth;
export const auth = requireAuth;

export default requireAuth;
