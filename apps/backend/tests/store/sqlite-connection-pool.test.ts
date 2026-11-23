import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { SqliteConnectionPool } from "../../src/store/sqlite-connection-pool.js";

describe("SQLite connection pool", () => {
  let directory: string | undefined;
  let pool: SqliteConnectionPool | undefined;

  afterEach(async () => {
    if (pool) await pool.close();
    if (directory) await fs.rm(directory, { recursive: true });
    pool = undefined;
    directory = undefined;
    vi.unstubAllEnvs();
  });

  it("reuses connections, evicts idle connections, and rejects exhaustion", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-pool-"));
    pool = new SqliteConnectionPool({
      path: path.join(directory, "store.db"),
      maxSize: 2,
      idleTimeoutMs: 40,
    });

    const first = await pool.acquire();
    const second = await pool.acquire();
    expect(pool.stats()).toMatchObject({ inUse: 2, maxSize: 2 });
    await expect(pool.acquire()).rejects.toThrow(/exhausted/i);

    await pool.release(first);
    await expect(pool.acquire()).resolves.toBe(first);
    await pool.release(first);
    await pool.release(second);
    expect(pool.stats().idle).toBe(2);

    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(pool.stats().idle).toBe(0);
    expect(pool.stats().total).toBe(0);
  });

  it("reads configurable pool limits from the environment", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-pool-config-"));
    vi.stubEnv("SQLITE_POOL_SIZE", "3");
    vi.stubEnv("SQLITE_POOL_IDLE_TIMEOUT_MS", "250");
    pool = new SqliteConnectionPool({ path: path.join(directory, "store.db") });

    expect(pool.stats()).toMatchObject({ maxSize: 3, idleTimeoutMs: 250 });
  });

  it("waits for checked-out connections to be released before closing", async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "sqlite-pool-close-"));
    pool = new SqliteConnectionPool({
      path: path.join(directory, "store.db"),
      maxSize: 1,
      idleTimeoutMs: 1000,
    });

    const connection = await pool.acquire();
    const closing = pool.close();
    await expect(pool.acquire()).rejects.toThrow(/closed/i);
    await pool.release(connection);
    await closing;
    expect(pool.stats().total).toBe(0);
  });

  it("rejects invalid pool configuration", () => {
    expect(
      () => new SqliteConnectionPool({ path: ":memory:", maxSize: 0 }),
    ).toThrow("SQLITE_POOL_SIZE must be a positive integer");
    expect(
      () =>
        new SqliteConnectionPool({
          path: ":memory:",
          idleTimeoutMs: Number.NaN,
        }),
    ).toThrow("SQLITE_POOL_IDLE_TIMEOUT_MS must be a positive integer");
  });
});
