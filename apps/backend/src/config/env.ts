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

/** Default idle timeout for pooled SQLite connections (30 seconds). */
const DEFAULT_SQLITE_POOL_IDLE_TIMEOUT_MS = 30 * 1000;

/**
 * Reads an optional string environment variable, falling back to a default.
 */
function parseString(name: string, defaultValue: string): string {
  const raw = process.env[name];

  if (raw === undefined || raw === '') {
    return defaultValue;
  }

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
}

/**
 * Loads and validates all environment variables required by the Oracle Service.
 * Throws on the first invalid value so the process fails fast at startup.
 */
function loadEnv(): Env {
  // Network, RPC endpoint and contract ids come from the canonical table in
  // environments.toml; conflicting overrides throw here (#118).
  const network = resolveNetworkConfig(process.env);
  return {
    stellarNetwork: network.network,
    stellarRpcUrl: network.rpcUrl,
    contractEscrow: network.contracts.escrow ?? '',
    contractOracle: network.contracts.oracle ?? '',
    lichessApiToken: process.env.LICHESS_API_TOKEN ?? '',
    chessdotcomApiKey: process.env.CHESSDOTCOM_API_KEY ?? '',
    pollingMaxRetries: parsePollingMaxRetries(),
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
  };
}

/**
 * Validated, typed environment configuration.
 * Evaluated once at module load time — any startup error surfaces immediately.
 */
export const env: Env = loadEnv();
