import type sqlite3 from "sqlite3";

/** SQLite is supported on local storage in one backend process only. */
export function sqliteSettings(env = process.env): { busyTimeoutMs: number } {
  if ((env.SQLITE_CONCURRENCY_MODE ?? "single-process") !== "single-process") {
    throw new Error("SQLite requires SQLITE_CONCURRENCY_MODE=single-process");
  }
  for (const key of ["BACKEND_REPLICAS", "WEB_CONCURRENCY"]) {
    if (env[key] !== undefined && Number(env[key]) !== 1) {
      throw new Error(
        `SQLite requires ${key}=1; multiple backend writers are unsupported`,
      );
    }
  }
  const busyTimeoutMs = Number(env.SQLITE_BUSY_TIMEOUT_MS ?? 5000);
  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs < 1 ||
    busyTimeoutMs > 60000
  ) {
    throw new Error(
      "SQLITE_BUSY_TIMEOUT_MS must be an integer between 1 and 60000",
    );
  }
  return { busyTimeoutMs };
}

export async function configureSqlite(db: sqlite3.Database): Promise<void> {
  db.configure("busyTimeout", sqliteSettings().busyTimeoutMs);
  await new Promise<void>((resolve, reject) => {
    db.get(
      "PRAGMA journal_mode=WAL",
      (err: Error | null, row: { journal_mode: string }) => {
        if (err) reject(err);
        else if (!["wal", "memory"].includes(row.journal_mode))
          reject(new Error("SQLite WAL mode unavailable"));
        else resolve();
      },
    );
  });
}

/** Connection pool configuration derived from the environment. */
export interface SqlitePoolSettings {
  /** Maximum number of live connections the pool will open. */
  maxSize: number;
  /** How long an idle connection may sit unused before it is closed. */
  idleTimeoutMs: number;
  /** How long an acquire() call waits for a free slot before failing. */
  acquireTimeoutMs: number;
}

export function sqlitePoolSettings(env = process.env): SqlitePoolSettings {
  const maxSize = Number(env.SQLITE_POOL_SIZE ?? 4);
  if (!Number.isSafeInteger(maxSize) || maxSize < 1 || maxSize > 64) {
    throw new Error("SQLITE_POOL_SIZE must be an integer between 1 and 64");
  }
  const idleTimeoutMs = Number(env.SQLITE_POOL_IDLE_TIMEOUT_MS ?? 30000);
  if (
    !Number.isSafeInteger(idleTimeoutMs) ||
    idleTimeoutMs < 1 ||
    idleTimeoutMs > 3600000
  ) {
    throw new Error(
      "SQLITE_POOL_IDLE_TIMEOUT_MS must be an integer between 1 and 3600000",
    );
  }
  const acquireTimeoutMs = Number(env.SQLITE_POOL_ACQUIRE_TIMEOUT_MS ?? 10000);
  if (
    !Number.isSafeInteger(acquireTimeoutMs) ||
    acquireTimeoutMs < 1 ||
    acquireTimeoutMs > 600000
  ) {
    throw new Error(
      "SQLITE_POOL_ACQUIRE_TIMEOUT_MS must be an integer between 1 and 600000",
    );
  }
  return { maxSize, idleTimeoutMs, acquireTimeoutMs };
}

interface PooledConnection {
  db: sqlite3.Database;
  /** Timestamp (ms) when the connection was last released back to the pool. */
  idleSince: number;
  /** True while the connection is checked out by a caller. */
  inUse: boolean;
  /** True once the connection has been closed or is being closed. */
  closed: boolean;
}

interface Waiter {
  resolve: (conn: PooledConnection) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SqlitePoolOptions extends Partial<SqlitePoolSettings> {
  /** Factory used to open a new underlying connection. */
  open: () => Promise<sqlite3.Database>;
}

/**
 * A bounded, reusable pool of SQLite connections.
 *
 * - At most `maxSize` connections are ever open at once.
 * - Released connections are reused by subsequent acquire() calls.
 * - Idle connections are closed after `idleTimeoutMs`.
 * - When all connections are checked out, acquire() waits up to
 *   `acquireTimeoutMs` before rejecting with a clear exhaustion error.
 */
export class SqliteConnectionPool {
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly open: () => Promise<sqlite3.Database>;

  private readonly connections = new Set<PooledConnection>();
  private readonly waiters: Waiter[] = [];
  private opening = 0;
  private closed = false;
  private idleTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: SqlitePoolOptions) {
    const defaults = sqlitePoolSettings();
    this.maxSize = options.maxSize ?? defaults.maxSize;
    this.idleTimeoutMs = options.idleTimeoutMs ?? defaults.idleTimeoutMs;
    this.acquireTimeoutMs =
      options.acquireTimeoutMs ?? defaults.acquireTimeoutMs;
    this.open = options.open;
  }

  /** Number of currently open connections (in use + idle). */
  get size(): number {
    return this.connections.size;
  }

  /** Number of connections currently checked out. */
  get inUseCount(): number {
    let count = 0;
    for (const conn of this.connections) if (conn.inUse) count += 1;
    return count;
  }

  /** Number of connections sitting idle in the pool. */
  get idleCount(): number {
    return this.connections.size - this.inUseCount;
  }

  /**
   * Check out a connection. Reuses an idle connection when available,
   * otherwise opens a new one if under the size limit, otherwise waits
   * (bounded) for a connection to be released.
   */
  async acquire(): Promise<sqlite3.Database> {
    if (this.closed) {
      throw new Error("SQLite connection pool is closed");
    }

    const idle = this.takeIdle();
    if (idle) return idle.db;

    if (this.connections.size + this.opening < this.maxSize) {
      return this.openNew();
    }

    return this.waitForRelease();
  }

  /** Return a connection to the pool so it can be reused. */
  release(db: sqlite3.Database): void {
    const conn = this.findByDb(db);
    if (!conn || !conn.inUse) return;
    conn.inUse = false;
    conn.idleSince = Date.now();

    const waiter = this.waiters.shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      conn.inUse = true;
      waiter.resolve(conn);
    }
  }

  /** Close all idle connections and reject pending waiters. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.stopIdleTimer();

    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("SQLite connection pool is closed"));
    }

    const closers: Promise<void>[] = [];
    for (const conn of this.connections) {
      if (!conn.inUse) closers.push(this.closeConnection(conn));
    }
    await Promise.all(closers);
  }

  private takeIdle(): PooledConnection | null {
    let oldest: PooledConnection | null = null;
    for (const conn of this.connections) {
      if (conn.inUse || conn.closed) continue;
      if (!oldest || conn.idleSince < oldest.idleSince) oldest = conn;
    }
    if (oldest) {
      oldest.inUse = true;
      return oldest;
    }
    return null;
  }

  private async openNew(): Promise<sqlite3.Database> {
    this.opening += 1;
    try {
      const db = await this.open();
      const conn: PooledConnection = {
        db,
        idleSince: Date.now(),
        inUse: true,
        closed: false,
      };
      this.connections.add(conn);
      this.ensureIdleTimer();
      return db;
    } finally {
      this.opening -= 1;
    }
  }

  private waitForRelease(): Promise<sqlite3.Database> {
    return new Promise<sqlite3.Database>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx !== -1) this.waiters.splice(idx, 1);
        reject(
          new Error(
            `SQLite connection pool exhausted: all ${this.maxSize} connections are in use; ` +
              `timed out after ${this.acquireTimeoutMs}ms waiting for a free connection`,
          ),
        );
      }, this.acquireTimeoutMs);

      this.waiters.push({
        resolve: (conn) => resolve(conn.db),
        reject,
        timer,
      });
    });
  }

  private findByDb(db: sqlite3.Database): PooledConnection | undefined {
    for (const conn of this.connections) if (conn.db === db) return conn;
    return undefined;
  }

  private ensureIdleTimer(): void {
    if (this.idleTimer || this.closed) return;
    const interval = Math.max(1, Math.min(this.idleTimeoutMs, 1000));
    this.idleTimer = setInterval(() => this.evictIdle(), interval);
    if (typeof this.idleTimer === "object" && "unref" in this.idleTimer) {
      (this.idleTimer as { unref: () => void }).unref();
    }
  }

  private stopIdleTimer(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }

  private evictIdle(): void {
    if (this.closed) return;
    const now = Date.now();
    for (const conn of this.connections) {
      if (conn.inUse || conn.closed) continue;
      if (now - conn.idleSince >= this.idleTimeoutMs) {
        void this.closeConnection(conn);
      }
    }
    if (this.connections.size === 0) this.stopIdleTimer();
  }

  private async closeConnection(conn: PooledConnection): Promise<void> {
    if (conn.closed) return;
    conn.closed = true;
    this.connections.delete(conn);
    await new Promise<void>((resolve) => {
      conn.db.close(() => resolve());
    });
  }
}

let singletonPool: SqliteConnectionPool | null = null;

/**
 * Get the process-wide SQLite connection pool, creating it on first use.
 * The pool opens connections lazily via the supplied factory.
 */
export function getSqlitePool(
  open: () => Promise<sqlite3.Database>,
): SqliteConnectionPool {
  if (!singletonPool) {
    singletonPool = new SqliteConnectionPool({ open });
  }
  return singletonPool;
}

/** Close and clear the singleton pool (used on shutdown and in tests). */
export async function closeSqlitePool(): Promise<void> {
  if (!singletonPool) return;
  const pool = singletonPool;
  singletonPool = null;
  await pool.close();
}