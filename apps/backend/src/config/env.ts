/**
 * Environment configuration for the smile4money Oracle Service.
 *
 * All environment variables are read and validated once at startup.
 * Invalid or missing required values throw immediately so the process
 * fails fast rather than misbehaving at runtime.
 *
 * Usage:
 *   import { env } from './config/env';
 *   console.log(env.pollingMaxRetries); // => 5
 */

import { resolveNetworkConfig } from './network.js';

/** Default maximum number of poll retries before a job is moved to the DLQ. */
const DEFAULT_POLLING_MAX_RETRIES = 5;

/** Default interval (ms) at which queue metrics are refreshed. */
const DEFAULT_QUEUE_METRICS_INTERVAL_MS = 15_000;

/** Default interval (ms) at which queue progress is sampled for stall detection. */
const DEFAULT_QUEUE_STALL_INTERVAL_MS = 30_000;

/** Default number of consecutive no-progress intervals before a stall alert. */
const DEFAULT_QUEUE_STALL_THRESHOLD = 3;
/** Default directory where encrypted database backups are written. */
const DEFAULT_BACKUP_DIR = './backups';

/** Default interval between automated backups (1 hour). */
const DEFAULT_BACKUP_INTERVAL_MS = 60 * 60 * 1000;

/** Default number of days to keep database backups before pruning. */
const DEFAULT_BACKUP_RETENTION_DAYS = 7;

/** Default number of jobs processed in a single database transaction. */
const DEFAULT_BATCH_SIZE = 50;

/** Default number of days to keep records before they are archived. */
const DEFAULT_RETENTION_DAYS = 90;

/** Default interval between automated archival runs (24 hours). */
const DEFAULT_ARCHIVE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Default maximum number of pooled SQLite connections. */
const DEFAULT_SQLITE_POOL_SIZE = 5;

/**
 * Default allowlist of hosts oracle provider endpoints may point at (#2121).
 * Empty means no host is allowed until explicitly configured.
 */
const DEFAULT_ORACLE_ENDPOINT_ALLOWLIST: readonly string[] = [];

/** Default set of Stellar addresses permitted to update oracle config (#2121). */
const DEFAULT_ORACLE_ADMIN_ADDRESSES: readonly string[] = [];

/** Default idle timeout for pooled SQLite connections (30 seconds). */
const DEFAULT_SQLITE_POOL_IDLE_TIMEOUT_MS = 30 * 1000;

/** Default session lifetime (1 hour) before a session expires (#2129). */
const DEFAULT_SESSION_TTL_MS = 60 * 60 * 1000;

/**
 * Reads an optional string environment variable, falling back to a default.
 */
function parseString(name: string, defaultValue: string): string {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = parseInt(raw, 10);

  if (isNaN(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be a positive integer, got: "${raw}"`);
  }

  if (parsed <= 0) {
    throw new Error(`${name} must be greater than zero, got: ${parsed}`);
  }

  return parsed;
}

/**
 * Parses a required-positive-number environment variable (allows decimals).
 *
 * Rules:
 *  - If the variable is absent or empty, `defaultValue` is used.
 *  - If the variable is present but not a finite number, startup fails.
 *  - If the parsed value is zero or negative, startup fails.
 *
 * @throws {Error} when the value is non-numeric, zero, or negative.
 */
function parsePositiveNumber(name: string, defaultValue: number): number {
  return raw;
}

/**
 * Parses a positive integer environment variable.
 *
 * Rules:
 *  - If the variable is absent or empty, the default is used.
 *  - If the variable is present but not a valid integer, startup fails.
 *  - If the parsed value is zero or negative, startup fails.
 *
 * @throws {Error} when the value is non-integer, zero, or negative.
 */
function parsePositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = Number(raw);

  if (!Number.isFinite(parsed)) {
    throw new Error(`${name} must be a positive number, got: "${raw}"`);
  const parsed = parseInt(raw, 10);

  if (isNaN(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be a positive integer, got: "${raw}"`);
  }

  if (parsed <= 0) {
    throw new Error(`${name} must be greater than zero, got: ${parsed}`);
  }

  return parsed;
}

/**
 * Parses a comma-separated list environment variable into a trimmed,
 * de-duplicated array of non-empty entries.
 *
 * Rules:
 *  - If the variable is absent or empty, `defaultValue` is used.
 *  - Entries are trimmed; empty entries are dropped.
 *  - Duplicate entries (case-insensitive) are collapsed, keeping the first.
 */
function parseStringList(
  name: string,
  defaultValue: readonly string[]
): string[] {
  const raw = process.env[name];

  if (raw === undefined || raw.trim() === '') {
    return [...defaultValue];
  }

  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();

    if (trimmed === '') {
      continue;
    }

    const key = trimmed.toLowerCase();

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(trimmed);
  }

  return result;
}

/**
 * Parses ORACLE_ENDPOINT_ALLOWLIST into a list of normalised hostnames (#2121).
 *
 * Each entry may be a bare host ("api.lichess.org") or a full URL
 * ("https://api.lichess.org"); only the hostname is retained. Entries must be
 * valid hostnames — anything else fails startup.
 *
 * @throws {Error} when an entry is not a valid hostname.
 */
function parseOracleEndpointAllowlist(): string[] {
  const entries = parseStringList(
    'ORACLE_ENDPOINT_ALLOWLIST',
    DEFAULT_ORACLE_ENDPOINT_ALLOWLIST
  );

  return entries.map((entry) => {
    let hostname = entry;

    if (entry.includes('://')) {
      try {
        hostname = new URL(entry).hostname;
      } catch {
        throw new Error(
          `ORACLE_ENDPOINT_ALLOWLIST contains an invalid URL: "${entry}"`
        );
      }
    }

    if (!isValidHostname(hostname)) {
      throw new Error(
        `ORACLE_ENDPOINT_ALLOWLIST contains an invalid hostname: "${entry}"`
      );
    }

    return hostname.toLowerCase();
  });
}

/**
 * Parses ORACLE_ADMIN_ADDRESSES into a list of Stellar addresses (#2121).
 *
 * Each entry must be a 56-character Stellar public key starting with "G".
 *
 * @throws {Error} when an entry is not a valid Stellar address.
 */
function parseOracleAdminAddresses(): string[] {
  const entries = parseStringList(
    'ORACLE_ADMIN_ADDRESSES',
    DEFAULT_ORACLE_ADMIN_ADDRESSES
  );

  for (const address of entries) {
    if (!/^G[A-Z2-7]{55}$/.test(address)) {
      throw new Error(
        `ORACLE_ADMIN_ADDRESSES contains an invalid Stellar address: "${address}"`
      );
    }
  }

  return entries;
}

/**
 * Returns true when `hostname` is a syntactically valid DNS hostname or IPv4
 * literal. Rejects empty labels, illegal characters and over-long labels.
 */
function isValidHostname(hostname: string): boolean {
  if (hostname === '' || hostname.length > 253) {
    return false;
  }

  const labels = hostname.split('.');

  return labels.every(
    (label) =>
      label.length > 0 &&
      label.length <= 63 &&
      /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?$/.test(label)
  );
}

/**
 * Parses DLQ_TTL_DAYS from the environment.
 *
 * @throws {Error} when the value is non-integer, zero, or negative.
 */
function parseDlqTtlDays(): number {
  return parsePositiveInt('DLQ_TTL_DAYS', DEFAULT_DLQ_TTL_DAYS);
}

/**
 * Parses DLQ_EXPIRATION_INTERVAL_MS from the environment.
 *
 * @throws {Error} when the value is non-integer, zero, or negative.
 */
function parseDlqExpirationIntervalMs(): number {
  return parsePositiveInt(
    'DLQ_EXPIRATION_INTERVAL_MS',
    DEFAULT_DLQ_EXPIRATION_INTERVAL_MS
  );
}

/** Per-job-type exponential backoff tuning. */
export interface BackoffConfig {
  /** Base delay before the first retry, in milliseconds. */
  baseDelayMs: number;

  /** Maximum delay cap between retries, in milliseconds. */
  maxDelayMs: number;

  /** Multiplier applied to the delay after each attempt. */
  multiplier: number;
}

/**
 * Normalises a job type into the env-var fragment used for overrides,
 * e.g. "game-result" / "game_result" / "GameResult" => "GAME_RESULT".
 */
function jobTypeEnvKey(jobType: string): string {
  return jobType
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
}

/**
 * Parses per-job-type backoff overrides from BACKOFF_<JOBTYPE>_BASE_DELAY_MS,
 * BACKOFF_<JOBTYPE>_MAX_DELAY_MS and BACKOFF_<JOBTYPE>_MULTIPLIER.
 *
 * Only job types with at least one override variable present are included;
 * missing fields fall back to the global backoff defaults.
 *
 * @throws {Error} when any present override value is invalid.
 */
function parseBackoffOverrides(
  defaults: BackoffConfig
): Record<string, BackoffConfig> {
  const prefix = 'BACKOFF_';
  const suffixes = ['_BASE_DELAY_MS', '_MAX_DELAY_MS', '_MULTIPLIER'] as const;
  const jobTypes = new Set<string>();

  for (const key of Object.keys(process.env)) {
    if (!key.startsWith(prefix)) {
      continue;
    }

    for (const suffix of suffixes) {
      if (key.endsWith(suffix) && key.length > prefix.length + suffix.length) {
        jobTypes.add(key.slice(prefix.length, key.length - suffix.length));
        break;
      }
    }
  }

  const overrides: Record<string, BackoffConfig> = {};

  for (const jobType of jobTypes) {
    overrides[jobType] = {
      baseDelayMs: parsePositiveInt(
        `${prefix}${jobType}_BASE_DELAY_MS`,
        defaults.baseDelayMs
      ),
      maxDelayMs: parsePositiveInt(
        `${prefix}${jobType}_MAX_DELAY_MS`,
        defaults.maxDelayMs
      ),
      multiplier: parsePositiveNumber(
        `${prefix}${jobType}_MULTIPLIER`,
        defaults.multiplier
      ),
    };
  }

  return overrides;
}

/**
 * Parses POLLING_MAX_RETRIES from the environment.
 *
 * Rules:
 *  - If the variable is absent, the default (5) is used.
 *  - If the variable is present but not a valid integer, startup fails.
 *  - If the parsed value is zero or negative, startup fails.
 *
 * @throws {Error} when the value is non-integer, zero, or negative.
 */
function parsePollingMaxRetries(): number {
  const raw = process.env.POLLING_MAX_RETRIES;

  if (raw === undefined || raw === '') {
    return DEFAULT_POLLING_MAX_RETRIES;
  }

  const parsed = parseInt(raw, 10);

  if (isNaN(parsed) || !Number.isInteger(parsed)) {
    throw new Error(
      `POLLING_MAX_RETRIES must be a positive integer, got: "${raw}"`
    );
  }

  if (parsed <= 0) {
    throw new Error(
      `POLLING_MAX_RETRIES must be greater than zero, got: ${parsed}`
    );
  }

  return parsed;
}

/**
 * Parses a positive-integer environment variable, falling back to `defaultValue`
 * when the variable is absent or empty.
 *
 * Rules:
 *  - If the variable is absent or empty, the default is used.
 *  - If the variable is present but not a valid integer, startup fails.
 *  - If the parsed value is zero or negative, startup fails.
 *
 * @throws {Error} when the value is non-integer, zero, or negative.
 */
function parsePositiveInt(name: string, defaultValue: number): number {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return defaultValue;
  }

  const parsed = parseInt(raw, 10);

  if (isNaN(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`${name} must be a positive integer, got: "${raw}"`);
  }

  if (parsed <= 0) {
    throw new Error(`${name} must be greater than zero, got: ${parsed}`);
  }

  return parsed;
}

export interface Env {
  /** Stellar network to connect to (e.g. "testnet", "mainnet"). */
  stellarNetwork: string;

  /** Stellar RPC endpoint URL. */
  stellarRpcUrl: string;

  /** Deployed escrow contract ID. */
  contractEscrow: string;

  /** Deployed oracle contract ID. */
  contractOracle: string;

  /** Lichess API token for game result polling. */
  lichessApiToken: string;

  /** Chess.com API key for game result polling. */
  chessdotcomApiKey: string;

  /**
   * Maximum number of times the oracle service polls the chess platform API
   * for a game result before moving the job to the dead-letter queue (DLQ).
   *
   * Sourced from POLLING_MAX_RETRIES. Defaults to 5 when unset.
   * Must be a positive integer — zero and negative values are rejected at startup.
   */
  pollingMaxRetries: number;

  /**
   * How often (in milliseconds) queue monitoring metrics — depth, age of the
   * oldest entry and success rate — are refreshed.
   *
   * Sourced from QUEUE_METRICS_INTERVAL_MS. Defaults to 15000 when unset.
   * Must be a positive integer.
   */
  queueMetricsIntervalMs: number;

  /**
   * Sampling interval (in milliseconds) used by queue stall detection to
   * compare progress between consecutive intervals.
   *
   * Sourced from QUEUE_STALL_INTERVAL_MS. Defaults to 30000 when unset.
   * Must be a positive integer.
   */
  queueStallIntervalMs: number;

  /**
   * Number of consecutive no-progress intervals after which the queue is
   * considered stalled and an alert is sent.
   *
   * Sourced from QUEUE_STALL_THRESHOLD. Defaults to 3 when unset.
   * Must be a positive integer.
   */
  queueStallThreshold: number;
  /** Directory where encrypted database backups are written (#2191). */
  backupDir: string;

  /** Interval in milliseconds between automated backups (#2191). */
  backupIntervalMs: number;

  /**
   * Key used to encrypt backups at rest (#2191).
   * Empty when unset; the backup job must refuse to run without it.
   */
  backupEncryptionKey: string;

  /** Number of days to keep backups before pruning (#2191). */
  backupRetentionDays: number;

  /** Number of jobs processed in a single database transaction (#2192). */
  batchSize: number;

  /** Number of days to keep records before they are archived (#2193). */
  retentionDays: number;

  /** Interval in milliseconds between automated archival runs (#2193). */
  archiveIntervalMs: number;

  /** Maximum number of pooled SQLite connections (#2196). */
  sqlitePoolSize: number;

  /** Idle timeout in milliseconds for pooled SQLite connections (#2196). */
  sqlitePoolIdleTimeoutMs: number;

  /**
   * Hostnames oracle provider endpoints are allowed to point at (#2121).
   * Sourced from ORACLE_ENDPOINT_ALLOWLIST (comma-separated). Endpoint updates
   * are rejected unless their host appears here.
   */
  oracleEndpointAllowlist: string[];

  /**
   * Key used to encrypt stored provider credentials at rest (#2121).
   * Empty when unset; config updates must refuse to persist credentials
   * without it.
   */
  oracleConfigEncryptionKey: string;

  /**
   * Stellar addresses permitted to update oracle configuration (#2121).
   * Sourced from ORACLE_ADMIN_ADDRESSES (comma-separated).
   */
  oracleAdminAddresses: string[];

  /**
   * Whitelisted frontend origins allowed to make browser (CORS) requests
   * (#2130).
   *
   * Sourced from CORS_ALLOWED_ORIGINS (or ALLOWED_ORIGINS as a fallback),
   * a comma-separated list of origins such as
   * "https://app.example.com,https://admin.example.com".
   * Empty when unset, in which case no cross-origin browser requests are
   * permitted.
   */
  corsAllowedOrigins: string[];

  /**
   * Lifetime of an authenticated session in milliseconds (#2129).
   *
   * Sourced from SESSION_TTL_MS. Defaults to 3600000 (1 hour) when unset.
   * Must be a positive integer; used to enforce session timeouts.
   */
  sessionTtlMs: number;

  /**
   * Shared secret used to verify HMAC-SHA256 request signatures for critical
   * operations (#2131).
   *
   * Sourced from REQUEST_SIGNING_SECRET. Empty when unset; signature
   * verification for critical operations must refuse to run without it.
   */
  requestSigningSecret: string;
}

/**
 * Loads and validates all environment variables required by the Oracle Service.
 * Throws on the first invalid value so the process fails fast at startup.
 */
function loadEnv(): Env {
  // Network, RPC endpoint and contract ids come from the canonical table in
  // environments.toml; conflicting overrides throw here (#118).
  const network = resolveNetworkConfig(process.env);

  const backoffBaseDelayMs = parsePositiveInt(
    'BACKOFF_BASE_DELAY_MS',
    DEFAULT_BACKOFF_BASE_DELAY_MS
  );
  const backoffMaxDelayMs = parsePositiveInt(
    'BACKOFF_MAX_DELAY_MS',
    DEFAULT_BACKOFF_MAX_DELAY_MS
  );
  const backoffMultiplier = parsePositiveNumber(
    'BACKOFF_MULTIPLIER',
    DEFAULT_BACKOFF_MULTIPLIER
  );

  return {
    stellarNetwork: network.network,
    stellarRpcUrl: network.rpcUrl,
    contractEscrow: network.contracts.escrow ?? '',
    contractOracle: network.contracts.oracle ?? '',
    lichessApiToken: process.env.LICHESS_API_TOKEN ?? '',
    chessdotcomApiKey: process.env.CHESSDOTCOM_API_KEY ?? '',
    pollingMaxRetries: parsePollingMaxRetries(),
    queueMetricsIntervalMs: parsePositiveInt(
      'QUEUE_METRICS_INTERVAL_MS',
      DEFAULT_QUEUE_METRICS_INTERVAL_MS
    ),
    queueStallIntervalMs: parsePositiveInt(
      'QUEUE_STALL_INTERVAL_MS',
      DEFAULT_QUEUE_STALL_INTERVAL_MS
    ),
    queueStallThreshold: parsePositiveInt(
      'QUEUE_STALL_THRESHOLD',
      DEFAULT_QUEUE_STALL_THRESHOLD
    backupDir: parseString('BACKUP_DIR', DEFAULT_BACKUP_DIR),
    backupIntervalMs: parsePositiveInt(
      'BACKUP_INTERVAL_MS',
      DEFAULT_BACKUP_INTERVAL_MS
    ),
    backupEncryptionKey: parseString('BACKUP_ENCRYPTION_KEY', ''),
    backupRetentionDays: parsePositiveInt(
      'BACKUP_RETENTION_DAYS',
      DEFAULT_BACKUP_RETENTION_DAYS
    ),
    batchSize: parsePositiveInt('BATCH_SIZE', DEFAULT_BATCH_SIZE),
    retentionDays: parsePositiveInt('RETENTION_DAYS', DEFAULT_RETENTION_DAYS),
    archiveIntervalMs: parsePositiveInt(
      'ARCHIVE_INTERVAL_MS',
      DEFAULT_ARCHIVE_INTERVAL_MS
    ),
    sqlitePoolSize: parsePositiveInt(
      'SQLITE_POOL_SIZE',
      DEFAULT_SQLITE_POOL_SIZE
    ),
    sqlitePoolIdleTimeoutMs: parsePositiveInt(
      'SQLITE_POOL_IDLE_TIMEOUT_MS',
      DEFAULT_SQLITE_POOL_IDLE_TIMEOUT_MS
    ),
    oracleEndpointAllowlist: parseOracleEndpointAllowlist(),
    oracleConfigEncryptionKey: parseString(
      'ORACLE_CONFIG_ENCRYPTION_KEY',
      ''
    ),
    oracleAdminAddresses: parseOracleAdminAddresses(),
    corsAllowedOrigins: parseString(
      'CORS_ALLOWED_ORIGINS',
      parseString('ALLOWED_ORIGINS', '')
    )
      .split(',')
      .map((origin) => origin.trim())
      .filter((origin) => origin.length > 0),
    sessionTtlMs: parsePositiveInt('SESSION_TTL_MS', DEFAULT_SESSION_TTL_MS),
    requestSigningSecret: parseString('REQUEST_SIGNING_SECRET', ''),
  };
}

/**
 * Validated, typed environment configuration.
 * Evaluated once at module load time — any startup error surfaces immediately.
 */
export const env: Env = loadEnv();
