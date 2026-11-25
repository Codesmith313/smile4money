import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { Express, Request, Response, NextFunction } from 'express';
import request from 'supertest';
import crypto from 'crypto';

// ---------------------------------------------------------------------------
// Permission levels
// ---------------------------------------------------------------------------
type PermissionLevel = 'read_only' | 'submit_results' | 'admin';

const PERMISSION_HIERARCHY: Record<PermissionLevel, number> = {
  read_only: 1,
  submit_results: 2,
  admin: 3,
};

function hasPermission(granted: PermissionLevel, required: PermissionLevel): boolean {
  return PERMISSION_HIERARCHY[granted] >= PERMISSION_HIERARCHY[required];
}

// ---------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------
interface Session {
  id: string;
  userId: string;
  permission: PermissionLevel;
  createdAt: number;
  expiresAt: number;
}

class SessionStore {
  private sessions = new Map<string, Session>();

  create(userId: string, permission: PermissionLevel, ttlMs = 60_000): Session {
    const id = crypto.randomBytes(16).toString('hex');
    const now = Date.now();
    const session: Session = {
      id,
      userId,
      permission,
      createdAt: now,
      expiresAt: now + ttlMs,
    };
    this.sessions.set(id, session);
    return session;
  }

  get(id: string): Session | undefined {
    const session = this.sessions.get(id);
    if (!session) return undefined;
    if (session.expiresAt <= Date.now()) {
      this.sessions.delete(id);
      return undefined;
    }
    return session;
  }

  invalidate(id: string): boolean {
    return this.sessions.delete(id);
  }

  clear(): void {
    this.sessions.clear();
  }
}

// ---------------------------------------------------------------------------
// Request signing (HMAC-SHA256)
// ---------------------------------------------------------------------------
const SIGNING_SECRET = 'test-signing-secret';
const SIGNATURE_MAX_AGE_MS = 5 * 60 * 1000;

function computeSignature(payload: string, timestamp: string): string {
  return crypto
    .createHmac('sha256', SIGNING_SECRET)
    .update(`${timestamp}.${payload}`)
    .digest('hex');
}

function verifySignature(
  payload: string,
  timestamp: string | undefined,
  signature: string | undefined
): { valid: boolean; reason?: string } {
  if (!timestamp || !signature) {
    return { valid: false, reason: 'missing_signature' };
  }
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) {
    return { valid: false, reason: 'invalid_timestamp' };
  }
  if (Math.abs(Date.now() - ts) > SIGNATURE_MAX_AGE_MS) {
    return { valid: false, reason: 'expired_signature' };
  }
  const expected = computeSignature(payload, timestamp);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { valid: false, reason: 'invalid_signature' };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Test app factory
// ---------------------------------------------------------------------------
const ALLOWED_ORIGINS = ['https://app.example.com', 'https://admin.example.com'];

interface TestAppOptions {
  sessionStore: SessionStore;
}

function buildApp({ sessionStore }: TestAppOptions): Express {
  const app = express();
  app.use(express.json());

  // CORS middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin && ALLOWED_ORIGINS.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization,Content-Type,X-Signature,X-Timestamp');
      res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
    if (req.method === 'OPTIONS') {
      if (origin && !ALLOWED_ORIGINS.includes(origin)) {
        res.status(403).end();
        return;
      }
      res.status(204).end();
      return;
    }
    if (origin && !ALLOWED_ORIGINS.includes(origin)) {
      res.status(403).json({ error: 'origin_not_allowed' });
      return;
    }
    next();
  });

  // Auth middleware
  const requireAuth = (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header || !header.startsWith('Bearer ')) {
      res.status(401).json({ error: 'unauthenticated' });
      return;
    }
    const sessionId = header.slice('Bearer '.length).trim();
    const session = sessionStore.get(sessionId);
    if (!session) {
      res.status(401).json({ error: 'invalid_or_expired_session' });
      return;
    }
    (req as any).session = session;
    next();
  };

  // Permission middleware factory
  const requirePermission = (required: PermissionLevel) => {
    return (req: Request, res: Response, next: NextFunction) => {
      const session: Session | undefined = (req as any).session;
      if (!session) {
        res.status(401).json({ error: 'unauthenticated' });
        return;
      }
      if (!hasPermission(session.permission, required)) {
        res.status(403).json({ error: 'insufficient_permission', required });
        return;
      }
      next();
    };
  };

  // Signature middleware factory
  const requireSignature = (req: Request, res: Response, next: NextFunction) => {
    const timestamp = req.headers['x-timestamp'] as string | undefined;
    const signature = req.headers['x-signature'] as string | undefined;
    const payload = JSON.stringify(req.body ?? {});
    const result = verifySignature(payload, timestamp, signature);
    if (!result.valid) {
      res.status(401).json({ error: 'invalid_signature', reason: result.reason });
      return;
    }
    next();
  };

  // ---- Routes ----

  // Auth: issue session
  app.post('/auth/login', (req: Request, res: Response) => {
    const { userId, permission } = req.body ?? {};
    if (!userId || !permission) {
      res.status(400).json({ error: 'missing_credentials' });
      return;
    }
    if (!(permission in PERMISSION_HIERARCHY)) {
      res.status(400).json({ error: 'invalid_permission' });
      return;
    }
    const session = sessionStore.create(userId, permission);
    res.status(200).json({ sessionId: session.id, expiresAt: session.expiresAt });
  });

  // Logout: invalidate session
  app.post('/auth/logout', requireAuth, (req: Request, res: Response) => {
    const session: Session = (req as any).session;
    sessionStore.invalidate(session.id);
    res.status(204).end();
  });

  // Read-only endpoint
  app.get('/results', requireAuth, requirePermission('read_only'), (_req, res) => {
    res.status(200).json({ results: [] });
  });

  // Submit endpoint
  app.post('/results', requireAuth, requirePermission('submit_results'), (_req, res) => {
    res.status(201).json({ submitted: true });
  });

  // Admin endpoint
  app.get('/admin/users', requireAuth, requirePermission('admin'), (_req, res) => {
    res.status(200).json({ users: [] });
  });

  // Critical operation requiring signature
  app.post('/admin/critical', requireAuth, requirePermission('admin'), requireSignature, (_req, res) => {
    res.status(200).json({ ok: true });
  });

  return app;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('security middleware', () => {
  let sessionStore: SessionStore;
  let app: Express;

  beforeEach(() => {
    sessionStore = new SessionStore();
    app = buildApp({ sessionStore });
  });

  afterEach(() => {
    sessionStore.clear();
    vi.useRealTimers();
  });

  async function login(permission: PermissionLevel, userId = 'user-1'): Promise<string> {
    const res = await request(app).post('/auth/login').send({ userId, permission });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
    return res.body.sessionId;
  }

  // -------------------------------------------------------------------------
  // Permission scoping
  // -------------------------------------------------------------------------
  describe('permission scoping', () => {
    it('allows read_only to access read endpoint', async () => {
      const sessionId = await login('read_only');
      const res = await request(app)
        .get('/results')
        .set('Authorization', `Bearer ${sessionId}`);
      expect(res.status).toBe(200);
    });

    it('denies read_only from submitting results (403)', async () => {
      const sessionId = await login('read_only');
      const res = await request(app)
        .post('/results')
        .set('Authorization', `Bearer ${sessionId}`)
        .send({ value: 1 });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('insufficient_permission');
    });

    it('denies read_only from admin endpoint (403)', async () => {
      const sessionId = await login('read_only');
      const res = await request(app)
        .get('/admin/users')
        .set('Authorization', `Bearer ${sessionId}`);
      expect(res.status).toBe(403);
    });

    it('allows submit_results to submit results', async () => {
      const sessionId = await login('submit_results');
      const res = await request(app)
        .post('/results')
        .set('Authorization', `Bearer ${sessionId}`)
        .send({ value: 1 });
      expect(res.status).toBe(201);
    });

    it('denies submit_results from admin endpoint (403)', async () => {
      const sessionId = await login('submit_results');
      const res = await request(app)
        .get('/admin/users')
        .set('Authorization', `Bearer ${sessionId}`);
      expect(res.status).toBe(403);
    });

    it('allows admin to access all endpoints', async () => {
      const sessionId = await login('admin');
      const readRes = await request(app)
        .get('/results')
        .set('Authorization', `Bearer ${sessionId}`);
      expect(readRes.status).toBe(200);

      const submitRes = await request(app)
        .post('/results')
        .set('Authorization', `Bearer ${sessionId}`)
        .send({ value: 1 });
      expect(submitRes.status).toBe(201);

      const adminRes = await request(app)
        .get('/admin/users')
        .set('Authorization', `Bearer ${sessionId}`);
      expect(adminRes.status).toBe(200);
    });

    it('returns 401 when no auth header is provided', async () => {
      const res = await request(app).get('/results');
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // Session management
  // -------------------------------------------------------------------------
  describe('session management', () => {
    it('issues a session ID on authentication', async () => {
      const res = await request(app)
        .post('/auth/login')
        .send({ userId: 'user-1', permission: 'read_only' });
      expect(res.status).toBe(200);
      expect(typeof res.body.sessionId).toBe('string');
      expect(res.body.sessionId.length).toBeGreaterThan(0);
      expect(res.body.expiresAt).toBeGreaterThan(Date.now());
    });

    it('logout invalidates the session', async () => {
      const sessionId = await login('read_only');

      const logoutRes = await request(app)
        .post('/auth/logout')
        .set('Authorization', `Bearer ${sessionId}`);
      expect(logoutRes.status).toBe(204);

      const afterRes = await request(app)
        .get('/results')
        .set('Authorization', `Bearer ${sessionId}`);
      expect(afterRes.status).toBe(401);
    });

    it('returns 401 for an expired session', async () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2024-01-01T00:00:00Z'));

      const session = sessionStore.create('user-1', 'read_only', 1000);
      expect(sessionStore.get(session.id)).toBeDefined();

      vi.setSystemTime(new Date('2024-01-01T00:00:02Z'));
      expect(sessionStore.get(session.id)).toBeUndefined();

      const res = await request(app)
        .get('/results')
        .set('Authorization', `Bearer ${session.id}`);
      expect(res.status).toBe(401);
    });

    it('returns 401 for an unknown session ID', async () => {
      const res = await request(app)
        .get('/results')
        .set('Authorization', 'Bearer does-not-exist');
      expect(res.status).toBe(401);
    });
  });

  // -------------------------------------------------------------------------
  // CORS
  // -------------------------------------------------------------------------
  describe('CORS validation', () => {
    it('echoes allowed origin in CORS headers', async () => {
      const sessionId = await login('read_only');
      const res = await request(app)
        .get('/results')
        .set('Origin', 'https://app.example.com')
        .set('Authorization', `Bearer ${sessionId}`);
      expect(res.status).toBe(200);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
    });

    it('rejects requests from unknown origins', async () => {
      const sessionId = await login('read_only');
      const res = await request(app)
        .get('/results')
        .set('Origin', 'https://evil.example.com')
        .set('Authorization', `Bearer ${sessionId}`);
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('origin_not_allowed');
    });

    it('handles OPTIONS preflight for allowed origin', async () => {
      const res = await request(app)
        .options('/results')
        .set('Origin', 'https://app.example.com')
        .set('Access-Control-Request-Method', 'GET');
      expect(res.status).toBe(204);
      expect(res.headers['access-control-allow-origin']).toBe('https://app.example.com');
      expect(res.headers['access-control-allow-methods']).toContain('GET');
    });

    it('rejects OPTIONS preflight from unknown origin', async () => {
      const res = await request(app)
        .options('/results')
        .set('Origin', 'https://evil.example.com')
        .set('Access-Control-Request-Method', 'GET');
      expect(res.status).toBe(403);
    });
  });

  // -------------------------------------------------------------------------
  // Request signing
  // -------------------------------------------------------------------------
  describe('request signing', () => {
    function sign(body: unknown, timestamp = Date.now()): { timestamp: string; signature: string } {
      const ts = String(timestamp);
      const payload = JSON.stringify(body ?? {});
      return { timestamp: ts, signature: computeSignature(payload, ts) };
    }

    it('accepts a valid signature on a critical route', async () => {
      const sessionId = await login('admin');
      const body = { action: 'delete', target: 'user-42' };
      const { timestamp, signature } = sign(body);

      const res = await request(app)
        .post('/admin/critical')
        .set('Authorization', `Bearer ${sessionId}`)
        .set('X-Timestamp', timestamp)
        .set('X-Signature', signature)
        .send(body);
      expect(res.status).toBe(200);
      expect(res.body.ok).toBe(true);
    });

    it('rejects an invalid signature', async () => {
      const sessionId = await login('admin');
      const body = { action: 'delete', target: 'user-42' };
      const { timestamp } = sign(body);

      const res = await request(app)
        .post('/admin/critical')
        .set('Authorization', `Bearer ${sessionId}`)
        .set('X-Timestamp', timestamp)
        .set('X-Signature', 'deadbeef'.repeat(8))
        .send(body);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_signature');
      expect(res.body.reason).toBe('invalid_signature');
    });

    it('rejects a missing signature', async () => {
      const sessionId = await login('admin');
      const body = { action: 'delete', target: 'user-42' };

      const res = await request(app)
        .post('/admin/critical')
        .set('Authorization', `Bearer ${sessionId}`)
        .send(body);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_signature');
      expect(res.body.reason).toBe('missing_signature');
    });

    it('rejects an expired signature', async () => {
      const sessionId = await login('admin');
      const body = { action: 'delete', target: 'user-42' };
      const staleTimestamp = Date.now() - 10 * 60 * 1000;
      const { timestamp, signature } = sign(body, staleTimestamp);

      const res = await request(app)
        .post('/admin/critical')
        .set('Authorization', `Bearer ${sessionId}`)
        .set('X-Timestamp', timestamp)
        .set('X-Signature', signature)
        .send(body);
      expect(res.status).toBe(401);
      expect(res.body.error).toBe('invalid_signature');
      expect(res.body.reason).toBe('expired_signature');
    });

    it('rejects a signature computed over a different payload', async () => {
      const sessionId = await login('admin');
      const signedBody = { action: 'delete', target: 'user-42' };
      const actualBody = { action: 'delete', target: 'user-99' };
      const { timestamp, signature } = sign(signedBody);

      const res = await request(app)
        .post('/admin/critical')
        .set('Authorization', `Bearer ${sessionId}`)
        .set('X-Timestamp', timestamp)
        .set('X-Signature', signature)
        .send(actualBody);
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('invalid_signature');
    });
  });
});