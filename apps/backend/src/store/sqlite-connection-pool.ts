import sqlite3 from "sqlite3";
import logger from "../logger.js";
import { openSqliteDatabase } from "./sqlite-config.js";

export interface SqliteConnectionPoolOptions {
  path?: string;
  dbPath?: string;
  maxSize?: number;
  idleTimeoutMs?: number;
}

interface PoolConnection {
  db: sqlite3.Database;
  inUse: boolean;
  idleTimer?: NodeJS.Timeout;
}

function positiveInteger(
  value: number | string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function closeDatabase(db: sqlite3.Database): Promise<void> {
  return new Promise((resolve, reject) =>
    db.close((error) => (error ? reject(error) : resolve())),
  );
}

export class SqliteConnectionPool {
  private readonly filename: string;
  private readonly maxSize: number;
  private readonly idleTimeoutMs: number;
  private readonly connections = new Set<PoolConnection>();
  private readonly idle: PoolConnection[] = [];
  private readonly openings = new Set<Promise<PoolConnection>>();
  private closed = false;
  private closePromise?: Promise<void>;
  private closeResolver?: () => void;

  constructor(options: SqliteConnectionPoolOptions) {
    this.filename = options.path ?? options.dbPath ?? "";
    if (!this.filename) {
      throw new Error("A SQLite database path is required");
    }
    this.maxSize = positiveInteger(
      options.maxSize ?? process.env.SQLITE_POOL_SIZE,
      "SQLITE_POOL_SIZE",
      5,
    );
    this.idleTimeoutMs = positiveInteger(
      options.idleTimeoutMs ?? process.env.SQLITE_POOL_IDLE_TIMEOUT_MS,
      "SQLITE_POOL_IDLE_TIMEOUT_MS",
      30_000,
    );
  }

  async acquire(): Promise<sqlite3.Database> {
    if (this.closed) {
      throw new Error("SQLite connection pool is closed");
    }

    const connection = this.idle.pop();
    if (connection) {
      if (connection.idleTimer) clearTimeout(connection.idleTimer);
      connection.idleTimer = undefined;
      connection.inUse = true;
      return connection.db;
    }

    if (this.connections.size + this.openings.size >= this.maxSize) {
      logger.warn("sqlite_pool_exhausted");
      throw new Error("SQLite connection pool exhausted");
    }

    const opening = this.openConnection();
    this.openings.add(opening);
    try {
      return (await opening).db;
    } finally {
      this.openings.delete(opening);
    }
  }

  async release(db: sqlite3.Database): Promise<void> {
    const connection = [...this.connections].find((item) => item.db === db);
    if (!connection) {
      throw new Error("SQLite connection does not belong to this pool");
    }
    if (!connection.inUse) {
      throw new Error("SQLite connection has already been released");
    }

    connection.inUse = false;
    if (this.closed) {
      try {
        await this.closeConnection(connection);
      } finally {
        this.resolveCloseIfDrained();
      }
      return;
    }

    this.idle.push(connection);
    connection.idleTimer = setTimeout(() => {
      if (!connection.inUse && !this.closed) {
        void this.evictIdleConnection(connection);
      }
    }, this.idleTimeoutMs);
    connection.idleTimer.unref();
  }

  stats(): {
    total: number;
    inUse: number;
    idle: number;
    opening: number;
    maxSize: number;
    idleTimeoutMs: number;
  } {
    const inUse = [...this.connections].filter(
      (connection) => connection.inUse,
    ).length;
    return {
      total: this.connections.size + this.openings.size,
      inUse,
      idle: this.idle.length,
      opening: this.openings.size,
      maxSize: this.maxSize,
      idleTimeoutMs: this.idleTimeoutMs,
    };
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = this.closeAll();
    return this.closePromise;
  }

  private async openConnection(): Promise<PoolConnection> {
    const db = await openSqliteDatabase(this.filename);
    if (this.closed) {
      await closeDatabase(db);
      throw new Error("SQLite connection pool is closed");
    }
    const connection = { db, inUse: true };
    this.connections.add(connection);
    return connection;
  }

  private async evictIdleConnection(connection: PoolConnection): Promise<void> {
    try {
      await this.closeConnection(connection);
      logger.info("sqlite_pool_evicted");
    } catch (error) {
      logger.error({ error }, "sqlite_pool_idle_close_failed");
    }
  }

  private async closeConnection(connection: PoolConnection): Promise<void> {
    if (connection.idleTimer) clearTimeout(connection.idleTimer);
    connection.idleTimer = undefined;
    const idleIndex = this.idle.indexOf(connection);
    if (idleIndex >= 0) this.idle.splice(idleIndex, 1);
    this.connections.delete(connection);
    await closeDatabase(connection.db);
  }

  private async closeAll(): Promise<void> {
    await Promise.all(
      [...this.openings].map((opening) =>
        opening.then(
          () => undefined,
          () => undefined,
        ),
      ),
    );

    const idleConnections = [...this.connections].filter(
      (connection) => !connection.inUse,
    );
    const idleCloseResults = await Promise.allSettled(
      idleConnections.map((connection) => this.closeConnection(connection)),
    );
    if ([...this.connections].some((connection) => connection.inUse)) {
      await new Promise<void>((resolve) => {
        this.closeResolver = resolve;
      });
    }
    const failedClose = idleCloseResults.find(
      (result) => result.status === "rejected",
    );
    if (failedClose?.status === "rejected") throw failedClose.reason;
  }

  private resolveCloseIfDrained(): void {
    if (this.connections.size === 0 && this.closeResolver) {
      const resolve = this.closeResolver;
      this.closeResolver = undefined;
      resolve();
    }
  }
}
