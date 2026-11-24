import type { SqliteMigration } from "./sqlite-migrations.js";

export const SQLITE_SCHEMA_MIGRATIONS: Record<string, SqliteMigration[]> = {
  "match-store": [
    {
      version: 1,
      name: "create-matches",
      statements: [
        `CREATE TABLE IF NOT EXISTS matches (
          matchId INTEGER PRIMARY KEY AUTOINCREMENT,
          player1 TEXT NOT NULL,
          player2 TEXT NOT NULL,
          player1Username TEXT,
          player2Username TEXT,
          stakeAmount REAL NOT NULL,
          token TEXT NOT NULL,
          gameId TEXT NOT NULL UNIQUE,
          platform TEXT NOT NULL,
          state TEXT NOT NULL DEFAULT 'Pending',
          identityHash TEXT
        )`,
      ],
      down: ["DROP TABLE IF EXISTS matches"],
    },
    {
      version: 2,
      name: "create-settlement-evidence",
      statements: [
        `CREATE TABLE IF NOT EXISTS settlement_evidence (
          evidenceId INTEGER PRIMARY KEY AUTOINCREMENT,
          matchId INTEGER NOT NULL,
          parserVersion TEXT NOT NULL,
          evaluatedAt TEXT NOT NULL,
          gameId TEXT NOT NULL,
          platform TEXT NOT NULL,
          whitePlayer TEXT NOT NULL,
          blackPlayer TEXT NOT NULL,
          result TEXT,
          status TEXT NOT NULL,
          decision TEXT NOT NULL
        )`,
      ],
      down: ["DROP TABLE IF EXISTS settlement_evidence"],
    },
    {
      version: 3,
      name: "index-match-and-evidence-lookups",
      statements: [
        `CREATE TABLE IF NOT EXISTS settlement_evidence (
          evidenceId INTEGER PRIMARY KEY AUTOINCREMENT,
          matchId INTEGER NOT NULL,
          parserVersion TEXT NOT NULL,
          evaluatedAt TEXT NOT NULL,
          gameId TEXT NOT NULL,
          platform TEXT NOT NULL,
          whitePlayer TEXT NOT NULL,
          blackPlayer TEXT NOT NULL,
          result TEXT,
          status TEXT NOT NULL,
          decision TEXT NOT NULL
        )`,
        "CREATE INDEX IF NOT EXISTS idx_matches_gameId ON matches(gameId)",
        "CREATE INDEX IF NOT EXISTS idx_matches_state ON matches(state)",
        "CREATE INDEX IF NOT EXISTS idx_settlement_evidence_matchId ON settlement_evidence(matchId)",
      ],
      down: [
        "DROP INDEX IF EXISTS idx_matches_gameId",
        "DROP INDEX IF EXISTS idx_matches_state",
        "DROP INDEX IF EXISTS idx_settlement_evidence_matchId",
      ],
    },
    {
      version: 4,
      name: "add-settlement-evidence-provider",
      statements: [
        "ALTER TABLE settlement_evidence ADD COLUMN provider TEXT",
        "UPDATE settlement_evidence SET provider = platform WHERE provider IS NULL",
      ],
      down: ["ALTER TABLE settlement_evidence DROP COLUMN provider"],
    },
  ],
  "oracle-queue": [
    {
      version: 1,
      name: "create-oracle-dlq",
      statements: [
        `CREATE TABLE IF NOT EXISTS oracle_dlq (
          id TEXT PRIMARY KEY NOT NULL,
          payload TEXT NOT NULL,
          failureReason TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          createdAt INTEGER NOT NULL,
          lastAttemptAt INTEGER,
          expireAt INTEGER NOT NULL,
          CONSTRAINT expireAt_check CHECK (expireAt > 0)
        )`,
      ],
      down: ["DROP TABLE IF EXISTS oracle_dlq"],
    },
    {
      version: 2,
      name: "index-oracle-dlq-lookups",
      statements: [
        "CREATE INDEX IF NOT EXISTS idx_oracle_dlq_expireAt ON oracle_dlq(expireAt)",
        "CREATE INDEX IF NOT EXISTS idx_oracle_dlq_created_at ON oracle_dlq(createdAt)",
      ],
      down: [
        "DROP INDEX IF EXISTS idx_oracle_dlq_expireAt",
        "DROP INDEX IF EXISTS idx_oracle_dlq_created_at",
      ],
    },
  ],
  "rate-limit": [
    {
      version: 1,
      name: "create-rate-limit-buckets",
      statements: [
        "CREATE TABLE IF NOT EXISTS rate_limit_buckets (clientId TEXT PRIMARY KEY NOT NULL, tokens REAL NOT NULL, lastRefill INTEGER NOT NULL)",
      ],
      down: ["DROP TABLE IF EXISTS rate_limit_buckets"],
    },
    {
      version: 2,
      name: "rate-limit-refill-index",
      statements: [
        "CREATE INDEX IF NOT EXISTS idx_rate_limit_last_refill ON rate_limit_buckets(lastRefill)",
      ],
      down: ["DROP INDEX IF EXISTS idx_rate_limit_last_refill"],
    },
    {
      version: 3,
      name: "rate-limit-tokens-index",
      statements: [
        "CREATE INDEX IF NOT EXISTS idx_rate_limit_tokens ON rate_limit_buckets(tokens)",
      ],
      down: ["DROP INDEX IF EXISTS idx_rate_limit_tokens"],
    },
  ],
  "circuit-breaker": [
    {
      version: 1,
      name: "create-circuit-breaker-state",
      statements: [
        `CREATE TABLE IF NOT EXISTS circuit_breaker_state (
          id TEXT PRIMARY KEY NOT NULL,
          state TEXT NOT NULL,
          failureCount INTEGER NOT NULL,
          successCount INTEGER NOT NULL,
          lastFailureTime INTEGER,
          openedAt INTEGER,
          attemptCount INTEGER NOT NULL,
          updatedAt INTEGER NOT NULL
        )`,
      ],
      down: ["DROP TABLE IF EXISTS circuit_breaker_state"],
    },
    {
      version: 2,
      name: "index-circuit-breaker-state-updated-at",
      statements: [
        "CREATE INDEX IF NOT EXISTS idx_circuit_breaker_state_updated_at ON circuit_breaker_state(updatedAt)",
      ],
      down: ["DROP INDEX IF EXISTS idx_circuit_breaker_state_updated_at"],
    },
  ],
  "oracle-evidence": [
    {
      version: 1,
      name: "create-oracle-decisions",
      statements: [
        "CREATE TABLE IF NOT EXISTS oracle_decisions (id INTEGER PRIMARY KEY AUTOINCREMENT, gameId TEXT NOT NULL, decision TEXT NOT NULL)",
      ],
      down: ["DROP TABLE IF EXISTS oracle_decisions"],
    },
    {
      version: 2,
      name: "index-oracle-decisions-game",
      statements: [
        "CREATE INDEX IF NOT EXISTS oracle_decisions_game ON oracle_decisions(gameId, id)",
      ],
      down: ["DROP INDEX IF EXISTS oracle_decisions_game"],
    },
  ],
  settlement: [
    {
      version: 1,
      name: "create-settlements",
      statements: [
        "CREATE TABLE IF NOT EXISTS settlements (scope TEXT NOT NULL, match_id INTEGER NOT NULL, game_id TEXT NOT NULL, record TEXT NOT NULL, PRIMARY KEY (scope, match_id, game_id))",
      ],
      down: ["DROP TABLE IF EXISTS settlements"],
    },
  ],
  sponsorship: [
    {
      version: 1,
      name: "create-sponsorships",
      statements: [
        "CREATE TABLE IF NOT EXISTS sponsorships (hash TEXT PRIMARY KEY, source TEXT NOT NULL, sequence TEXT NOT NULL, day INTEGER NOT NULL, fee INTEGER NOT NULL, UNIQUE(source, sequence))",
      ],
      down: ["DROP TABLE IF EXISTS sponsorships"],
    },
  ],
};

export function getSqliteMigrationsForDatabase(
  databasePath: string,
  migrationSet?: string,
): SqliteMigration[] {
  const inferredSet = databasePath
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.db(?:-.*)?$/, "");
  const setName = migrationSet ?? inferredSet;
  const migrations = setName ? SQLITE_SCHEMA_MIGRATIONS[setName] : undefined;
  if (!migrations) {
    throw new Error(
      `No SQLite migrations registered for "${setName ?? databasePath}". ` +
        `Specify one of: ${Object.keys(SQLITE_SCHEMA_MIGRATIONS).join(", ")}`,
    );
  }
  return migrations;
}
