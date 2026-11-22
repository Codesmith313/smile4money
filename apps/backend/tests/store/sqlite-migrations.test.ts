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

  it("applies and rolls back every registered SQLite migration set", async () => {
    for (const migrations of Object.values(SQLITE_SCHEMA_MIGRATIONS)) {
      const database = new sqlite3.Database(":memory:");
      try {
        const applied = await applySqliteMigrations(database, migrations);
        expect(applied.currentVersion).toBe(migrations.length);
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
});
