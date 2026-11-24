import { Request, Response, NextFunction } from 'express';
import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
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
  }
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
  if (!auth || !auth.startsWith('Bearer ')) {
    logAuthFailure('missing_or_invalid_authorization_header', auditContext);
    return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Missing or invalid Authorization header'));
  }

  const token = auth.slice(7);
  try {
    const payload = jwt.verify(token, SECRET) as { address?: string };
    if (!payload || typeof payload.address !== 'string') {
      logAuthFailure('invalid_token_payload', auditContext);
      return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Invalid token payload'));
    }
    logAuthSuccess(payload.address, auditContext);
    req.address = payload.address;
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
