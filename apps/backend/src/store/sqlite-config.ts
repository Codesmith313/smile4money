import crypto from "node:crypto";
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

/** Fields of the oracle configuration that may be updated via the admin API. */
export interface OracleConfigPatch {
  apiEndpoint?: string;
  apiKey?: string;
  apiSecret?: string;
}

/** Oracle configuration as exposed to read APIs; secrets are never included. */
export interface OracleConfigView {
  apiEndpoint: string | null;
  hasApiKey: boolean;
  hasApiSecret: boolean;
  updatedAt: string | null;
  updatedBy: string | null;
}

export interface OracleConfigAuditEntry {
  actor: string;
  changedFields: string[];
  timestamp: string;
}

const ORACLE_CONFIG_TABLE = "oracle_config";
const ORACLE_CONFIG_AUDIT_TABLE = "oracle_config_audit";
const ORACLE_SECRET_FIELDS = ["apiKey", "apiSecret"] as const;
const ORACLE_PLAIN_FIELDS = ["apiEndpoint"] as const;

function encryptionKey(env = process.env): Buffer {
  const raw = env.ORACLE_CONFIG_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("ORACLE_CONFIG_ENCRYPTION_KEY must be set");
  }
  const key = /^[0-9a-fA-F]{64}$/.test(raw)
    ? Buffer.from(raw, "hex")
    : Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new Error(
      "ORACLE_CONFIG_ENCRYPTION_KEY must decode to 32 bytes (AES-256)",
    );
  }
  return key;
}

/** Encrypts a secret with AES-256-GCM; output is `iv:tag:ciphertext` (base64). */
export function encryptSecret(
  plaintext: string,
  env = process.env,
): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(env), iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((b) => b.toString("base64")).join(":");
}

/** Decrypts a value produced by {@link encryptSecret}. */
export function decryptSecret(payload: string, env = process.env): string {
  const parts = payload.split(":");
  if (parts.length !== 3) {
    throw new Error("Malformed encrypted secret");
  }
  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64"));
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(env),
    iv,
  );
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString("utf8");
}

/** Validates an oracle API endpoint; throws when it is not a usable URL. */
export function validateOracleEndpoint(endpoint: string): string {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new Error("Oracle API endpoint must be a valid URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Oracle API endpoint must use http or https");
  }
  if (!url.hostname) {
    throw new Error("Oracle API endpoint must include a hostname");
  }
  return url.toString();
}

async function ensureOracleConfigTables(db: sqlite3.Database): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS ${ORACLE_CONFIG_TABLE} (
         key TEXT PRIMARY KEY,
         value TEXT NOT NULL,
         encrypted INTEGER NOT NULL DEFAULT 0,
         updated_at TEXT NOT NULL,
         updated_by TEXT NOT NULL
       );
       CREATE TABLE IF NOT EXISTS ${ORACLE_CONFIG_AUDIT_TABLE} (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         actor TEXT NOT NULL,
         changed_fields TEXT NOT NULL,
         timestamp TEXT NOT NULL
       );`,
      (err: Error | null) => {
        if (err) reject(err);
        else resolve();
      },
    );
  });
}

function dbGet(
  db: sqlite3.Database,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown> | undefined> {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err: Error | null, row: Record<string, unknown>) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbAll(
  db: sqlite3.Database,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err: Error | null, rows: Record<string, unknown>[]) => {
      if (err) reject(err);
      else resolve(rows ?? []);
    });
  });
}

function dbRun(
  db: sqlite3.Database,
  sql: string,
  params: unknown[] = [],
): Promise<void> {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

/**
 * Reads the oracle configuration. Secret values are never returned; callers
 * only learn whether a credential is present.
 */
export async function getOracleConfig(
  db: sqlite3.Database,
): Promise<OracleConfigView> {
  await ensureOracleConfigTables(db);
  const rows = await dbAll(
    db,
    `SELECT key, value, updated_at, updated_by FROM ${ORACLE_CONFIG_TABLE}`,
  );
  const byKey = new Map(rows.map((row) => [String(row.key), row]));
  const endpoint = byKey.get("apiEndpoint");
  const apiKey = byKey.get("apiKey");
  const apiSecret = byKey.get("apiSecret");
  const latest = rows.reduce<Record<string, unknown> | undefined>(
    (acc, row) =>
      !acc || String(row.updated_at) > String(acc.updated_at) ? row : acc,
    undefined,
  );
  return {
    apiEndpoint: endpoint ? String(endpoint.value) : null,
    hasApiKey: Boolean(apiKey),
    hasApiSecret: Boolean(apiSecret),
    updatedAt: latest ? String(latest.updated_at) : null,
    updatedBy: latest ? String(latest.updated_by) : null,
  };
}

/**
 * Applies a patch to the oracle configuration, encrypting secret values at
 * rest and recording an audit row for the change. Returns the updated view.
 */
export async function setOracleConfig(
  db: sqlite3.Database,
  patch: OracleConfigPatch,
  actor: string,
  env = process.env,
): Promise<OracleConfigView> {
  if (!actor || !actor.trim()) {
    throw new Error("An actor is required to update oracle configuration");
  }
  await ensureOracleConfigTables(db);
  const changedFields: string[] = [];
  const now = new Date().toISOString();

  for (const field of ORACLE_PLAIN_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    const normalized = validateOracleEndpoint(value);
    await dbRun(
      db,
      `INSERT INTO ${ORACLE_CONFIG_TABLE} (key, value, encrypted, updated_at, updated_by)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, encrypted=0,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      [field, normalized, now, actor],
    );
    changedFields.push(field);
  }

  for (const field of ORACLE_SECRET_FIELDS) {
    const value = patch[field];
    if (value === undefined) continue;
    if (!value) {
      throw new Error(`Oracle ${field} must not be empty`);
    }
    const encrypted = encryptSecret(value, env);
    await dbRun(
      db,
      `INSERT INTO ${ORACLE_CONFIG_TABLE} (key, value, encrypted, updated_at, updated_by)
       VALUES (?, ?, 1, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value=excluded.value, encrypted=1,
         updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
      [field, encrypted, now, actor],
    );
    changedFields.push(field);
  }

  if (changedFields.length === 0) {
    throw new Error("No oracle configuration fields supplied");
  }

  await dbRun(
    db,
    `INSERT INTO ${ORACLE_CONFIG_AUDIT_TABLE} (actor, changed_fields, timestamp)
     VALUES (?, ?, ?)`,
    [actor, JSON.stringify(changedFields), now],
  );

  return getOracleConfig(db);
}

/** Returns the audit trail of oracle configuration changes, newest first. */
export async function getOracleConfigAudit(
  db: sqlite3.Database,
): Promise<OracleConfigAuditEntry[]> {
  await ensureOracleConfigTables(db);
  const rows = await dbAll(
    db,
    `SELECT actor, changed_fields, timestamp FROM ${ORACLE_CONFIG_AUDIT_TABLE}
     ORDER BY id DESC`,
  );
  return rows.map((row) => ({
    actor: String(row.actor),
    changedFields: JSON.parse(String(row.changed_fields)) as string[],
    timestamp: String(row.timestamp),
  }));
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

/** Tunable oracle parameters persisted in SQLite. */
export interface OracleParams {
  retryCount: number;
  timeoutMs: number;
  batchSize: number;
}

const ORACLE_PARAM_KEYS = ["retryCount", "timeoutMs", "batchSize"] as const;
type OracleParamKey = (typeof ORACLE_PARAM_KEYS)[number];

const ORACLE_PARAM_ENV: Record<OracleParamKey, string> = {
  retryCount: "ORACLE_RETRY_COUNT",
  timeoutMs: "ORACLE_TIMEOUT_MS",
  batchSize: "ORACLE_BATCH_SIZE",
};

const ORACLE_PARAM_DEFAULTS: OracleParams = {
  retryCount: 3,
  timeoutMs: 30000,
  batchSize: 100,
};

let oracleDb: sqlite3.Database | null = null;
let oracleCache: OracleParams | null = null;
let oracleInitPromise: Promise<void> | null = null;

function validatePositiveInteger(key: string, value: unknown): number {
  const num = typeof value === "string" ? Number(value) : value;
  if (
    typeof num !== "number" ||
    !Number.isSafeInteger(num) ||
    num < 1
  ) {
    throw new Error(`${key} must be a positive integer`);
  }
  return num;
}

function envDefaults(env = process.env): OracleParams {
  const result: OracleParams = { ...ORACLE_PARAM_DEFAULTS };
  for (const key of ORACLE_PARAM_KEYS) {
    const raw = env[ORACLE_PARAM_ENV[key]];
    if (raw !== undefined && raw !== "") {
      result[key] = validatePositiveInteger(ORACLE_PARAM_ENV[key], raw);
    }
  }
  return result;
}

function run(db: sqlite3.Database, sql: string, params: unknown[] = []): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    db.run(sql, params, (err: Error | null) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

function all(
  db: sqlite3.Database,
  sql: string,
  params: unknown[] = [],
): Promise<Record<string, unknown>[]> {
  return new Promise<Record<string, unknown>[]>((resolve, reject) => {
    db.all(sql, params, (err: Error | null, rows: Record<string, unknown>[]) => {
      if (err) reject(err);
      else resolve(rows ?? []);
    });
  });
}

async function ensureOracleConfigTable(db: sqlite3.Database): Promise<void> {
  await run(
    db,
    `CREATE TABLE IF NOT EXISTS oracle_config (
       key TEXT PRIMARY KEY,
       value TEXT NOT NULL,
       updated_at TEXT NOT NULL DEFAULT (datetime('now'))
     )`,
  );
}

async function loadOracleParams(db: sqlite3.Database): Promise<OracleParams> {
  await ensureOracleConfigTable(db);
  const rows = await all(db, "SELECT key, value FROM oracle_config");
  const stored = new Map<string, string>();
  for (const row of rows) {
    stored.set(String(row.key), String(row.value));
  }
  const defaults = envDefaults();
  const result: OracleParams = { ...defaults };
  for (const key of ORACLE_PARAM_KEYS) {
    const raw = stored.get(key);
    if (raw !== undefined) {
      result[key] = validatePositiveInteger(key, raw);
    }
  }
  // Seed any missing values so subsequent reads are stable.
  for (const key of ORACLE_PARAM_KEYS) {
    if (!stored.has(key)) {
      await run(
        db,
        `INSERT INTO oracle_config (key, value) VALUES (?, ?)
         ON CONFLICT(key) DO NOTHING`,
        [key, String(result[key])],
      );
    }
  }
  return result;
}

/**
 * Initializes the oracle config store against the given database handle.
 * Safe to call multiple times; the first successful call wins.
 */
export async function initOracleConfigStore(
  db: sqlite3.Database,
): Promise<void> {
  if (oracleInitPromise) return oracleInitPromise;
  oracleInitPromise = (async () => {
    oracleDb = db;
    oracleCache = await loadOracleParams(db);
  })();
  try {
    await oracleInitPromise;
  } catch (err) {
    oracleInitPromise = null;
    oracleDb = null;
    oracleCache = null;
    throw err;
  }
}

function requireDb(): sqlite3.Database {
  if (!oracleDb) {
    throw new Error(
      "Oracle config store not initialized; call initOracleConfigStore() first",
    );
  }
  return oracleDb;
}

/**
 * Returns the current oracle parameters. Values are cached in memory and
 * refreshed whenever setOracleParams() writes new values, so tuning takes
 * effect on the next oracle operation without a restart.
 */
export async function getOracleParams(): Promise<OracleParams> {
  if (oracleCache) return { ...oracleCache };
  const db = requireDb();
  oracleCache = await loadOracleParams(db);
  return { ...oracleCache };
}

/**
 * Persists the given oracle parameters (partial updates allowed) and
 * invalidates the in-memory cache so the next read reflects the change.
 */
export async function setOracleParams(
  updates: Partial<OracleParams>,
): Promise<OracleParams> {
  const db = requireDb();
  const validated: Partial<OracleParams> = {};
  for (const key of ORACLE_PARAM_KEYS) {
    const value = updates[key];
    if (value !== undefined) {
      validated[key] = validatePositiveInteger(key, value);
    }
  }
  await ensureOracleConfigTable(db);
  for (const key of ORACLE_PARAM_KEYS) {
    const value = validated[key];
    if (value === undefined) continue;
    await run(
      db,
      `INSERT INTO oracle_config (key, value, updated_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value,
         updated_at = excluded.updated_at`,
      [key, String(value)],
    );
  }
  oracleCache = null;
  return getOracleParams();
}

/** Clears the in-memory cache. Primarily useful for tests. */
export function resetOracleConfigCache(): void {
  oracleCache = null;
}