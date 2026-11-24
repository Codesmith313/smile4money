import { afterEach, describe, expect, it } from "vitest";
import sqlite3 from "sqlite3";
import {
  applySqliteMigrations,
  getCurrentSchemaVersion,
  rollbackSqliteMigrations,
} from "../../src/store/sqlite-migrations.js";
import { SQLITE_SCHEMA_MIGRATIONS } from "../../src/store/sqlite-schema-migrations.js";

describe("SQLite schema migrations", () => {
  let db: sqlite3.Database | undefined;

  afterEach(async () => {
    if (db) {
      await new Promise<void>((resolve, reject) =>
        db!.close((error) => (error ? reject(error) : resolve())),
      );
      db = undefined;
    }
  });

  it("records applied versions and rolls back to the requested version", async () => {
    db = new sqlite3.Database(":memory:");
    const migrations = SQLITE_SCHEMA_MIGRATIONS["rate-limit"];

    await expect(applySqliteMigrations(db, migrations)).resolves.toEqual({
      currentVersion: 3,
      appliedMigrations: [
        "create-rate-limit-buckets",
        "rate-limit-refill-index",
        "rate-limit-tokens-index",
      ],
    });
    await expect(applySqliteMigrations(db, migrations)).resolves.toEqual({
      currentVersion: 3,
      appliedMigrations: [],
    });
    await expect(getCurrentSchemaVersion(db)).resolves.toBe(3);

    await expect(rollbackSqliteMigrations(db, migrations, 2)).resolves.toEqual({
      currentVersion: 2,
      rolledBackMigrations: ["rate-limit-tokens-index"],
    });
    await expect(getCurrentSchemaVersion(db)).resolves.toBe(2);
    const index = await new Promise<{ name: string } | undefined>(
      (resolve, reject) =>
        db!.get(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_rate_limit_tokens'",
          (error, row: { name: string } | undefined) =>
            error ? reject(error) : resolve(row),
        ),
    );
    expect(index).toBeUndefined();
  });

  it("rejects a rollback target above the current schema version", async () => {
    db = new sqlite3.Database(":memory:");
    const migrations = SQLITE_SCHEMA_MIGRATIONS["rate-limit"];
    await applySqliteMigrations(db, migrations);

    await expect(rollbackSqliteMigrations(db, migrations, 4)).rejects.toThrow(
      "Cannot roll back to schema version 4",
    );
  });

  it("makes oracle decisions append-only and prevents rolling back that protection", async () => {
    db = new sqlite3.Database(":memory:");
    const migrations = SQLITE_SCHEMA_MIGRATIONS["oracle-evidence"];
    await applySqliteMigrations(db, migrations);
    await new Promise<void>((resolve, reject) =>
      db!.run(
        "INSERT INTO oracle_decisions(gameId, decision) VALUES ('game', '{}')",
        (error) => (error ? reject(error) : resolve()),
      ),
    );

    const run = (sql: string) =>
      new Promise<void>((resolve, reject) =>
        db!.run(sql, (error) => (error ? reject(error) : resolve())),
      );
    await expect(
      run("UPDATE oracle_decisions SET decision = '{\"changed\":true}'"),
    ).rejects.toThrow("oracle decisions are immutable");
    await expect(run("DELETE FROM oracle_decisions")).rejects.toThrow(
      "oracle decisions are immutable",
    );
    await expect(rollbackSqliteMigrations(db, migrations, 2)).rejects.toThrow(
      "has no down statements to roll back",
    );

    const row = await new Promise<{ decision: string }>((resolve, reject) =>
      db!.get(
        "SELECT decision FROM oracle_decisions WHERE gameId = 'game'",
        (error, result: { decision: string }) =>
          error ? reject(error) : resolve(result),
      ),
    );
    expect(row.decision).toBe("{}");
  });

  it("applies and rolls back every registered SQLite migration set", async () => {
    for (const migrations of Object.values(SQLITE_SCHEMA_MIGRATIONS)) {
      const database = new sqlite3.Database(":memory:");
      try {
        const applied = await applySqliteMigrations(database, migrations);
        expect(applied.currentVersion).toBe(migrations.length);
        if (migrations.some((migration) => !migration.down?.length)) {
          await expect(
            rollbackSqliteMigrations(database, migrations, 0),
          ).rejects.toThrow("has no down statements to roll back");
          continue;
        }
        const rolledBack = await rollbackSqliteMigrations(
          database,
          migrations,
          0,
        );
        expect(rolledBack.currentVersion).toBe(0);
        expect(rolledBack.rolledBackMigrations).toHaveLength(migrations.length);
      } finally {
        await new Promise<void>((resolve, reject) =>
          database.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  });

  it("applies and rolls back the credential store migration set", async () => {
    db = new sqlite3.Database(":memory:");
    const migrations = SQLITE_SCHEMA_MIGRATIONS["api-credentials"];

    const applied = await applySqliteMigrations(db, migrations);
    expect(applied.currentVersion).toBe(migrations.length);
    expect(applied.appliedMigrations).toHaveLength(migrations.length);

    const table = await new Promise<{ name: string } | undefined>(
      (resolve, reject) =>
        db!.get(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_credentials'",
          (error, row: { name: string } | undefined) =>
            error ? reject(error) : resolve(row),
        ),
    );
    expect(table?.name).toBe("api_credentials");

    const rolledBack = await rollbackSqliteMigrations(db, migrations, 0);
    expect(rolledBack.currentVersion).toBe(0);
    expect(rolledBack.rolledBackMigrations).toHaveLength(migrations.length);

    const droppedTable = await new Promise<{ name: string } | undefined>(
      (resolve, reject) =>
        db!.get(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'api_credentials'",
          (error, row: { name: string } | undefined) =>
            error ? reject(error) : resolve(row),
        ),
    );
    expect(droppedTable).toBeUndefined();
  });

  it("adds and rolls back the dispute window columns on matches", async () => {
    db = new sqlite3.Database(":memory:");
    const migrations = SQLITE_SCHEMA_MIGRATIONS["match-store"];
    await applySqliteMigrations(db, migrations);

    const columns = await new Promise<Array<{ name: string }>>(
      (resolve, reject) =>
        db!.all(
          "PRAGMA table_info(matches)",
          (error, rows: Array<{ name: string }>) =>
            error ? reject(error) : resolve(rows),
        ),
    );
    const columnNames = columns.map((column) => column.name);
    expect(columnNames).toContain("resultSubmittedAt");
    expect(columnNames).toContain("disputeWindowEndsAt");

    const rolledBack = await rollbackSqliteMigrations(
      db,
      migrations,
      migrations.length - 1,
    );
    expect(rolledBack.currentVersion).toBe(migrations.length - 1);

    const columnsAfterRollback = await new Promise<Array<{ name: string }>>(
      (resolve, reject) =>
        db!.all(
          "PRAGMA table_info(matches)",
          (error, rows: Array<{ name: string }>) =>
            error ? reject(error) : resolve(rows),
        ),
    );
    const rolledBackColumnNames = columnsAfterRollback.map(
      (column) => column.name,
    );
    expect(rolledBackColumnNames).not.toContain("resultSubmittedAt");
    expect(rolledBackColumnNames).not.toContain("disputeWindowEndsAt");
  });

  it("adds and backfills the provider column in settlement evidence", async () => {
    db = new sqlite3.Database(":memory:");
    const migrations = SQLITE_SCHEMA_MIGRATIONS["match-store"];
    await applySqliteMigrations(db, migrations.slice(0, 3));
    await new Promise<void>((resolve, reject) =>
      db!.run(
        `INSERT INTO settlement_evidence
          (matchId, parserVersion, evaluatedAt, gameId, platform, whitePlayer, blackPlayer, result, status, decision)
         VALUES (1, 'v1', '2026-01-01T00:00:00.000Z', 'game', 'lichess', 'alice', 'bob', 'Player1Wins', 'mate', 'verified')`,
        (error) => (error ? reject(error) : resolve()),
      ),
    );
    await applySqliteMigrations(db, migrations);

    const result = await new Promise<{ provider: string }>((resolve, reject) =>
        db!.all(
          "SELECT provider FROM settlement_evidence WHERE gameId = 'game'",
          (error, rows: Array<{ provider: string }>) =>
            error ? reject(error) : resolve(rows[0]),
        ),
    );
    expect(result.provider).toBe("lichess");
  });
});
