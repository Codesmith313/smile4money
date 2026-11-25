import { Request, Response, NextFunction } from 'express';
import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import crypto from 'crypto';
import { ErrorCode, errorEnvelope } from '../errors/errorResponse.js';
import { privateEnv } from '../config/private-env.js';
import { logAuthFailure, logAuthSuccess } from '../audit/authAudit.js';

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
    /** Session id associated with the authenticated request. */
    sessionId?: string;
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
 * Granular permission scopes. A token's scope determines which endpoints it
 * may call. `admin` implies every other permission.
 */
export enum Permission {
  READ_ONLY = 'read_only',
  SUBMIT_RESULTS = 'submit_results',
  ADMIN = 'admin',
}

const PERMISSION_HIERARCHY: Record<Permission, number> = {
  [Permission.READ_ONLY]: 1,
  [Permission.SUBMIT_RESULTS]: 2,
  [Permission.ADMIN]: 3,
};

function normalizePermissions(raw: unknown): Permission[] {
  const values = Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : [];
  const valid = values.filter((v): v is Permission =>
    Object.values(Permission).includes(v as Permission),
  );
  return valid.length > 0 ? valid : [Permission.READ_ONLY];
}

function hasPermission(granted: Permission[], required: Permission): boolean {
  const requiredLevel = PERMISSION_HIERARCHY[required];
  return granted.some((p) => PERMISSION_HIERARCHY[p] >= requiredLevel);
}

/**
 * Middleware factory enforcing a minimum permission scope on an endpoint.
 * Must run after `authenticate`. Returns 403 when the principal's scope is
 * insufficient.
 */
export function requirePermission(permission: Permission) {
  return (req: Request, res: Response, next: NextFunction) => {
    const granted = req.permissions ?? [Permission.READ_ONLY];
    if (!hasPermission(granted, permission)) {
      return res
        .status(403)
        .json(
          errorEnvelope(
            ErrorCode.FORBIDDEN,
            `Insufficient permissions: '${permission}' required`,
          ),
        );
    }
    next();
  };
}

/**
 * In-memory session store. Sessions are issued on successful authentication
 * and must be validated on every request.
 */
export interface SessionRecord {
  session_id: string;
  principal: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
}

const SESSION_TTL_MS = 60 * 60 * 1000; // 1 hour
const sessions = new Map<string, SessionRecord>();

export function createSession(principal: string): SessionRecord {
  const now = Date.now();
  const record: SessionRecord = {
    session_id: crypto.randomUUID(),
    principal,
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
    revoked_at: null,
  };
  sessions.set(record.session_id, record);
  return record;
}

export function getSession(sessionId: string): SessionRecord | undefined {
  return sessions.get(sessionId);
}

export function revokeSession(sessionId: string): boolean {
  const record = sessions.get(sessionId);
  if (!record) return false;
  record.revoked_at = Date.now();
  return true;
}

function isSessionValid(record: SessionRecord | undefined): boolean {
  if (!record) return false;
  if (record.revoked_at !== null) return false;
  if (record.expires_at <= Date.now()) return false;
  return true;
}

const SIGNATURE_MAX_SKEW_MS = 5 * 60 * 1000; // 5 minutes
const usedNonces = new Map<string, number>();

function pruneNonces(now: number) {
  for (const [nonce, ts] of usedNonces) {
    if (now - ts > SIGNATURE_MAX_SKEW_MS) usedNonces.delete(nonce);
  }
}

function computeSignature(
  method: string,
  path: string,
  body: string,
  timestamp: string,
  nonce: string,
): string {
  const secret = privateEnv.requestSigningSecret || SECRET;
  const payload = `${method.toUpperCase()}\n${path}\n${body}\n${timestamp}\n${nonce}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Middleware requiring a valid HMAC-SHA256 request signature for critical
 * operations. Expects headers:
 *   X-Signature: hex HMAC-SHA256 over method+path+body+timestamp+nonce
 *   X-Timestamp: epoch milliseconds
 *   X-Nonce:     unique per-request value (replay protection)
 */
export function requireSignature(req: Request, res: Response, next: NextFunction) {
  const signature = req.header('X-Signature');
  const timestamp = req.header('X-Timestamp');
  const nonce = req.header('X-Nonce');

  if (!signature || !timestamp || !nonce) {
    return res
      .status(401)
      .json(
        errorEnvelope(
          ErrorCode.UNAUTHORIZED,
          'Missing request signature headers',
        ),
      );
  }

  const ts = Number(timestamp);
  const now = Date.now();
  if (!Number.isFinite(ts) || Math.abs(now - ts) > SIGNATURE_MAX_SKEW_MS) {
    return res
      .status(401)
      .json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Stale or invalid signature timestamp'));
  }

  pruneNonces(now);
  if (usedNonces.has(nonce)) {
    return res
      .status(401)
      .json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Signature nonce already used'));
  }

  const body = req.body ? JSON.stringify(req.body) : '';
  const expected = computeSignature(req.method, req.originalUrl, body, timestamp, nonce);

  if (!timingSafeEqualHex(expected, signature)) {
    return res
      .status(403)
      .json(errorEnvelope(ErrorCode.FORBIDDEN, 'Invalid request signature'));
  }

  usedNonces.set(nonce, now);
  next();
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
  // Non-sensitive client identifier for audit context. The IP is used only for
  // security auditing and is never included in client-facing responses.
  const auditContext = {
    path: req.originalUrl || req.path,
    ip: req.ip,
  };

  const auth = req.header('Authorization');
  if (!auth) {
    logAuthFailure('missing_or_invalid_authorization_header', auditContext);
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
    logAuthFailure('missing_or_invalid_authorization_header', auditContext);
    return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Missing or invalid Authorization header'));
  }

  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, SECRET) as {
      address?: string;
      sub?: string;
      tier?: string;
      type?: string;
      scope?: unknown;
      permissions?: unknown;
      session_id?: string;
    };
    if (!payload || typeof payload.address !== 'string') {
      logAuthFailure('invalid_token_payload', auditContext);
      return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Invalid token payload'));
    }
    // Refresh tokens are opaque and must never be accepted as access tokens.
    if (payload.type && payload.type !== 'access') {
      return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Invalid token type'));
    }

    // Session validation: a token bound to a session must reference a live,
    // non-revoked, non-expired session.
    if (typeof payload.session_id === 'string') {
      const record = getSession(payload.session_id);
      if (!isSessionValid(record)) {
        return res
          .status(401)
          .json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Session is invalid or has expired'));
      }
      req.sessionId = payload.session_id;
    } else {
      const record = createSession(payload.address);
      req.sessionId = record.session_id;
    }

    req.address = payload.address;
    req.userId = payload.sub ?? payload.address;
    req.userTier = payload.tier;
    req.permissions = normalizePermissions(payload.scope ?? payload.permissions);
    req.authType = 'jwt';
    res.setHeader('X-Session-Id', req.sessionId);
    next();
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      logAuthFailure('token_expired', auditContext);
      return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Token has expired'));
    }
    if (error instanceof JsonWebTokenError) {
      logAuthFailure('invalid_token_signature', auditContext);
      return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Invalid token'));
    }
    logAuthFailure('unknown_authentication_error', auditContext);
    return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Authentication failed'));
  }
}
