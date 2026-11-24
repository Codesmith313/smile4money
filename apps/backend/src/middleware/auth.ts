import { Request, Response, NextFunction } from 'express';
import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import crypto from 'crypto';
import { ErrorCode, errorEnvelope } from '../errors/errorResponse.js';
import { privateEnv } from '../config/private-env.js';

/**
 * JWT_SECRET is used to sign and verify authentication tokens.
 * REQUIRED: Must be a strong, random string set in the environment.
 * If not set, defaults to 'test-secret' for development only.
 * NEVER use default in production.
 */
const DEFAULT_SECRET = 'test-secret';
const SECRET = privateEnv.jwtSecret || DEFAULT_SECRET;

// Hard fail at startup in production: a missing or default JWT_SECRET lets
// anyone forge tokens with the well-known default, so refusing to start is
// the only safe behavior. The default is only acceptable for local development.
if (process.env.NODE_ENV === 'production' && SECRET === DEFAULT_SECRET) {
  throw new Error(
    'JWT_SECRET is not set (or is set to the known default "test-secret"). ' +
      'Refusing to start in production. Set JWT_SECRET to a strong, random ' +
      'string in your environment variables.',
  );
}

declare module 'express-serve-static-core' {
  interface Request {
    address?: string;
    /** Authenticated user id (JWT subject or API key owner). */
    userId?: string;
    /** User tier used for per-tier rate limiting. */
    userTier?: string;
    /** Permissions granted by an API key (empty for JWT auth). */
    permissions?: string[];
    /** How the request was authenticated. */
    authType?: 'jwt' | 'apiKey';
  }
}

/** Access token lifetime (seconds). */
export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;
/** Refresh token lifetime (seconds). */
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export interface AccessTokenPayload {
  address: string;
  sub?: string;
  tier?: string;
  type?: 'access';
}

export interface RefreshTokenRecord {
  id: string;
  userId: string;
  tokenHash: string;
  expiresAt: number;
  revokedAt?: number;
  rotatedTo?: string;
}

export interface ApiKeyRecord {
  id: string;
  userId: string;
  keyHash: string;
  permissions: string[];
  expiresAt?: number;
  revokedAt?: number;
}

/**
 * In-memory stores. In production these should be backed by the
 * `refresh_tokens` and `api_keys` tables; the interfaces above mirror those
 * schemas so the persistence layer can be swapped in without touching callers.
 */
const refreshTokens = new Map<string, RefreshTokenRecord>();
const apiKeys = new Map<string, ApiKeyRecord>();

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function generateOpaqueToken(): string {
  return crypto.randomBytes(48).toString('base64url');
}

/**
 * Issue a short-lived access token plus a rotating opaque refresh token.
 * Only the hash of the refresh token is stored at rest.
 */
export function issueTokens(payload: AccessTokenPayload): {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} {
  const accessToken = jwt.sign(
    { ...payload, type: 'access' },
    SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  );

  const refreshToken = generateOpaqueToken();
  const id = crypto.randomUUID();
  refreshTokens.set(hashToken(refreshToken), {
    id,
    userId: payload.sub ?? payload.address,
    tokenHash: hashToken(refreshToken),
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000,
  });

  return { accessToken, refreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/**
 * Verify a refresh token and rotate it: the presented token is revoked and a
 * new access/refresh pair is issued. Revoked, rotated or expired tokens are
 * rejected.
 */
export function refreshTokens_(refreshToken: string): {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
} | null {
  const tokenHash = hashToken(refreshToken);
  const record = refreshTokens.get(tokenHash);
  if (!record) return null;
  if (record.revokedAt || record.rotatedTo) return null;
  if (record.expiresAt <= Date.now()) {
    refreshTokens.delete(tokenHash);
    return null;
  }

  const newRefreshToken = generateOpaqueToken();
  const newHash = hashToken(newRefreshToken);
  const newId = crypto.randomUUID();

  record.revokedAt = Date.now();
  record.rotatedTo = newId;

  refreshTokens.set(newHash, {
    id: newId,
    userId: record.userId,
    tokenHash: newHash,
    expiresAt: Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000,
  });

  const accessToken = jwt.sign(
    { address: record.userId, sub: record.userId, type: 'access' },
    SECRET,
    { expiresIn: ACCESS_TOKEN_TTL_SECONDS },
  );

  return { accessToken, refreshToken: newRefreshToken, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/** Revoke a single refresh token (e.g. on logout). */
export function revokeRefreshToken(refreshToken: string): boolean {
  const tokenHash = hashToken(refreshToken);
  const record = refreshTokens.get(tokenHash);
  if (!record) return false;
  record.revokedAt = Date.now();
  return true;
}

/** Revoke all refresh tokens belonging to a user. */
export function revokeAllRefreshTokens(userId: string): number {
  let count = 0;
  for (const record of refreshTokens.values()) {
    if (record.userId === userId && !record.revokedAt) {
      record.revokedAt = Date.now();
      count++;
    }
  }
  return count;
}

/**
 * Generate a new API key for machine-to-machine auth. The plaintext key is
 * returned exactly once; only its hash is stored.
 */
export function generateApiKey(
  userId: string,
  permissions: string[] = [],
  expiresInSeconds?: number,
): { id: string; apiKey: string; permissions: string[] } {
  const apiKey = `sk_${generateOpaqueToken()}`;
  const id = crypto.randomUUID();
  apiKeys.set(hashToken(apiKey), {
    id,
    userId,
    keyHash: hashToken(apiKey),
    permissions: [...permissions],
    expiresAt: expiresInSeconds ? Date.now() + expiresInSeconds * 1000 : undefined,
  });
  return { id, apiKey, permissions: [...permissions] };
}

/** Revoke an API key by its plaintext value. */
export function revokeApiKey(apiKey: string): boolean {
  const record = apiKeys.get(hashToken(apiKey));
  if (!record) return false;
  record.revokedAt = Date.now();
  return true;
}

/** Revoke an API key by its stored id. */
export function revokeApiKeyById(id: string): boolean {
  for (const record of apiKeys.values()) {
    if (record.id === id) {
      record.revokedAt = Date.now();
      return true;
    }
  }
  return false;
}

function validateApiKey(apiKey: string): ApiKeyRecord | null {
  const record = apiKeys.get(hashToken(apiKey));
  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt !== undefined && record.expiresAt <= Date.now()) return null;
  return record;
}

/**
 * Authentication middleware that verifies JWT tokens in the Authorization header.
 * Extracts the Stellar address from the JWT payload and attaches it to req.address.
 *
 * Expected header format: "Authorization: Bearer <jwt-token>"
 * JWT payload must contain: { address: "<stellar-address>" }
 *
 * Returns:
 * - 401 if no Authorization header is provided
 * - 401 if token is malformed or invalid
 * - 401 if token has expired
 * - 401 if token doesn't contain a valid address claim
 */
export function authenticate(req: Request, res: Response, next: NextFunction) {
  const auth = req.header('Authorization');
  if (!auth) {
    return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Missing or invalid Authorization header'));
  }

  // API key authentication: "Authorization: ApiKey <key>"
  if (auth.startsWith('ApiKey ')) {
    const apiKey = auth.slice(7).trim();
    const record = validateApiKey(apiKey);
    if (!record) {
      return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Invalid or revoked API key'));
    }
    req.userId = record.userId;
    req.address = record.userId;
    req.permissions = record.permissions;
    req.authType = 'apiKey';
    return next();
  }

  if (!auth.startsWith('Bearer ')) {
    return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Missing or invalid Authorization header'));
  }

  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, SECRET) as {
      address?: string;
      sub?: string;
      tier?: string;
      type?: string;
    };
    if (!payload || typeof payload.address !== 'string') {
      return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Invalid token payload'));
    }
    // Refresh tokens are opaque and must never be accepted as access tokens.
    if (payload.type && payload.type !== 'access') {
      return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Invalid token type'));
    }
    req.address = payload.address;
    req.userId = payload.sub ?? payload.address;
    req.userTier = payload.tier;
    req.permissions = [];
    req.authType = 'jwt';
    next();
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Token has expired'));
    }
    if (error instanceof JsonWebTokenError) {
      return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Invalid token'));
    }
    return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Authentication failed'));
  }
}
