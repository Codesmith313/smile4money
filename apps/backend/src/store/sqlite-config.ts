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

/**
 * Runs `PRAGMA integrity_check` against the given database and reports the
 * outcome. A healthy database returns a single row with value "ok"; any other
 * result indicates corruption or other integrity problems.
 */
export async function runIntegrityCheck(
  db: sqlite3.Database,
): Promise<{ ok: boolean; results: string[] }> {
  const rows = await new Promise<Record<string, unknown>[]>(
    (resolve, reject) => {
      db.all(
        "PRAGMA integrity_check",
        (err: Error | null, result: Record<string, unknown>[]) => {
          if (err) reject(err);
          else resolve(result ?? []);
        },
      );
    },
  );
  const results = rows.map((row) => {
    const values = Object.values(row);
    return values.length > 0 ? String(values[0]) : "";
  });
  const ok = results.length === 1 && results[0] === "ok";
  return { ok, results };
}

/**
 * Runs `PRAGMA optimize` to refresh query-planner statistics. Intended to be
 * called after migrations have been applied.
 */
export async function runOptimize(db: sqlite3.Database): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    db.exec("PRAGMA optimize", (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Opens a SQLite database at the given file, applies the shared configuration
 * (busy timeout, WAL journal mode), and returns the open handle. Maintenance
 * jobs and the migration CLI use this so every database file is opened
 * consistently.
 */
export async function openSqliteDatabase(
  file: string,
): Promise<sqlite3.Database> {
  const sqlite3Module = await import("sqlite3");
  const Database = sqlite3Module.default?.Database ?? sqlite3Module.Database;
  const db = await new Promise<sqlite3.Database>((resolve, reject) => {
    const handle = new Database(file, (err: Error | null) => {
      if (err) reject(err);
      else resolve(handle);
    });
  });
  try {
    await configureSqlite(db);
  } catch (err) {
    await new Promise<void>((resolve) => {
      db.close(() => resolve());
    });
    throw err;
  }
  return db;
}