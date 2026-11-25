import crypto from 'crypto';
import { getDb } from '../db';

export type CredentialStatus = 'active' | 'previous';

export interface ApiCredential {
  id: number;
  name: string;
  hashed_secret: string;
  status: CredentialStatus;
  created_at: number;
  expires_at: number | null;
}

export interface RotateResult {
  id: number;
  name: string;
  secret: string;
  created_at: number;
}

const CACHE_TTL_MS = 30_000;
const DEFAULT_GRACE_PERIOD_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  credentials: ApiCredential[];
  loadedAt: number;
}

let cache: CacheEntry | null = null;

function now(): number {
  return Date.now();
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function generateSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function ensureTable(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS api_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      hashed_secret TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('active', 'previous')),
      created_at INTEGER NOT NULL,
      expires_at INTEGER
    );
  `);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_api_credentials_status ON api_credentials (status);`
  );
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_api_credentials_hashed_secret ON api_credentials (hashed_secret);`
  );
}

function invalidateCache(): void {
  cache = null;
}

function loadCredentialsFromDb(): ApiCredential[] {
  ensureTable();
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id, name, hashed_secret, status, created_at, expires_at
       FROM api_credentials
       WHERE status = 'active'
          OR (status = 'previous' AND (expires_at IS NULL OR expires_at > ?))
       ORDER BY created_at DESC`
    )
    .all(now()) as ApiCredential[];
  return rows;
}

/**
 * Load active and non-expired previous credentials, using a short-lived
 * in-memory cache to avoid hitting SQLite on every verification.
 */
export function loadCredentials(): ApiCredential[] {
  const current = now();
  if (cache && current - cache.loadedAt < CACHE_TTL_MS) {
    return cache.credentials;
  }
  const credentials = loadCredentialsFromDb();
  cache = { credentials, loadedAt: current };
  return credentials;
}

/**
 * Secure env fallback used when the store is empty. Supports a single
 * fallback secret provided via API_CREDENTIAL_FALLBACK_SECRET.
 */
function getEnvFallbackCredentials(): ApiCredential[] {
  const fallback = process.env.API_CREDENTIAL_FALLBACK_SECRET;
  if (!fallback) {
    return [];
  }
  return [
    {
      id: -1,
      name: 'env-fallback',
      hashed_secret: hashSecret(fallback),
      status: 'active',
      created_at: 0,
      expires_at: null,
    },
  ];
}

/**
 * Verify a presented secret against active and non-expired previous
 * credentials. Falls back to the env secret when the store is empty.
 */
export function verifySecret(presentedSecret: string): boolean {
  if (!presentedSecret || typeof presentedSecret !== 'string') {
    return false;
  }

  const presentedHash = hashSecret(presentedSecret);
  let credentials = loadCredentials();

  if (credentials.length === 0) {
    credentials = getEnvFallbackCredentials();
  }

  const current = now();
  for (const cred of credentials) {
    if (cred.status === 'previous' && cred.expires_at !== null && cred.expires_at <= current) {
      continue;
    }
    if (timingSafeEqualHex(cred.hashed_secret, presentedHash)) {
      return true;
    }
  }
  return false;
}

function timingSafeEqualHex(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Rotate a credential by name. Generates a new secret, marks the prior
 * active credential as 'previous' with an expiry of now + grace period,
 * and invalidates any older previous credentials for that name.
 */
export function rotateCredential(
  name: string,
  gracePeriodMs: number = DEFAULT_GRACE_PERIOD_MS
): RotateResult {
  ensureTable();
  const db = getDb();
  const current = now();
  const secret = generateSecret();
  const hashed = hashSecret(secret);

  const rotate = db.transaction(() => {
    // Invalidate older previous credentials for this name.
    db.prepare(
      `UPDATE api_credentials
       SET status = 'previous', expires_at = ?
       WHERE name = ? AND status = 'previous'`
    ).run(current, name);

    // Demote the current active credential to previous with grace period.
    db.prepare(
      `UPDATE api_credentials
       SET status = 'previous', expires_at = ?
       WHERE name = ? AND status = 'active'`
    ).run(current + gracePeriodMs, name);

    // Insert the new active credential.
    const info = db
      .prepare(
        `INSERT INTO api_credentials (name, hashed_secret, status, created_at, expires_at)
         VALUES (?, ?, 'active', ?, NULL)`
      )
      .run(name, hashed, current);

    return Number(info.lastInsertRowid);
  });

  const id = rotate();
  invalidateCache();

  return { id, name, secret, created_at: current };
}

/**
 * Purge expired previous credentials. Safe to call periodically.
 */
export function purgeExpiredCredentials(): number {
  ensureTable();
  const db = getDb();
  const info = db
    .prepare(
      `DELETE FROM api_credentials
       WHERE status = 'previous' AND expires_at IS NOT NULL AND expires_at <= ?`
    )
    .run(now());
  invalidateCache();
  return info.changes;
}

/**
 * Explicitly invalidate the in-memory cache. Useful after external writes.
 */
export function invalidateCredentialCache(): void {
  invalidateCache();
}