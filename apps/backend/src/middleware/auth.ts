import { Request, Response, NextFunction } from 'express';
import jwt, { JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { ErrorCode, errorEnvelope } from '../errors/errorResponse.js';
import { privateEnv } from '../config/private-env.js';
import { getJwtVerificationSecrets } from '../security/credentialStore.js';

/**
 * JWT_SECRET is used to sign and verify authentication tokens.
 * REQUIRED: Must be a strong, random string set in the environment.
 * If not set, defaults to 'test-secret' for development only.
 * NEVER use default in production.
 */
const DEFAULT_SECRET = 'test-secret';

// Hard fail at startup in production: a missing or default JWT_SECRET lets
// anyone forge tokens with the well-known default, so refusing to start is
// the only safe behavior. The default is only acceptable for local development.
if (process.env.NODE_ENV === 'production' && !privateEnv.jwtSecret) {
  throw new Error(
    'JWT_SECRET is not set (or is set to the known default "test-secret"). ' +
      'Refusing to start in production. Set JWT_SECRET to a strong, random ' +
      'string in your environment variables.',
  );
}

/**
 * Resolves the set of secrets that may currently verify a token.
 *
 * The credential store returns the active secret first, followed by any
 * previous secret still inside its rotation grace period. Resolving this per
 * request (rather than caching a module-level constant) means credentials can
 * be rotated without restarting the backend, and tokens signed with the old
 * secret keep working until the grace period elapses.
 */
function resolveVerificationSecrets(): string[] {
  const secrets = getJwtVerificationSecrets();
  if (secrets.length === 0) {
    // Fall back to the environment-provided secret (or the dev default) so
    // the middleware keeps working if the store has not been initialized.
    return [privateEnv.jwtSecret || DEFAULT_SECRET];
  }
  return secrets;
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
  const auth = req.header('Authorization');
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Missing or invalid Authorization header'));
  }

  const token = auth.slice(7);
  try {
    const secrets = resolveVerificationSecrets();
    let payload: { address?: string } | undefined;
    let lastError: unknown;

    // Try the active secret first, then any previous secret still within its
    // grace period, so rotation never interrupts in-flight sessions.
    for (const secret of secrets) {
      try {
        payload = jwt.verify(token, secret) as { address?: string };
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (lastError) {
      throw lastError;
    }

    if (!payload || typeof payload.address !== 'string') {
      return res.status(401).json(errorEnvelope(ErrorCode.UNAUTHORIZED, 'Invalid token payload'));
    }
    req.address = payload.address;
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
