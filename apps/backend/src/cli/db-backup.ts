/**
 * Oracle database backup CLI (#104). See docs/oracle-db-recovery.md.
 *
 *   tsx src/cli/db-backup.ts backup    <database> <backup-dir>
 *   tsx src/cli/db-backup.ts verify    <backup-file>
 *   tsx src/cli/db-backup.ts restore   <backup-file> <database>   # service stopped
 *   tsx src/cli/db-backup.ts prune     <database> <backup-dir> [retention-days]
 *   tsx src/cli/db-backup.ts migrate   <database> [migration-set]
 *   tsx src/cli/db-backup.ts rollback  <database> <target-version> [migration-set]
 *   tsx src/cli/db-backup.ts status    <database>
 *   tsx src/cli/db-backup.ts integrity <database>
 *
 * `backup` also verifies the new file and prunes old ones, so one scheduled
 * command covers the whole routine. Exits non-zero on any failure, so a
 * scheduler or monitor sees a missed backup.
 *
 * When the backup directory argument is omitted, `backup` falls back to the
 * BACKUP_DIR environment variable. When BACKUP_ENCRYPTION_KEY is set, the new
 * backup is encrypted at rest (see `encrypt`).
 */
import path from "path";
import {
  backupFileName,
  backupSqliteDatabase,
  encryptBackupFile,
  pruneBackups,
  restoreSqliteDatabase,
  verifySqliteBackup,
} from "../store/sqlite-backup.js";
import {
  applySqliteMigrations,
  getCurrentSchemaVersion,
  rollbackSqliteMigrations,
} from "../store/sqlite-migrations.js";
import { getSqliteMigrationsForDatabase } from "../store/sqlite-schema-migrations.js";
import {
  openSqliteDatabase,
  runIntegrityCheck,
} from "../store/sqlite-config.js";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Default retention, matching docs/oracle-db-recovery.md. */
export const DEFAULT_RETENTION_DAYS = 35;

function retentionMs(raw: string | undefined): number {
  const days = raw === undefined ? DEFAULT_RETENTION_DAYS : Number(raw);
  if (!Number.isFinite(days) || days <= 0)
    throw new Error(`invalid retention days: ${raw}`);
  return days * DAY_MS;
}

export async function main(argv: string[]): Promise<number> {
  const [command, a, b, c] = argv;
  switch (command) {
    case "backup": {
      const dir = b ?? process.env.BACKUP_DIR;
      if (!a || !dir) break;
      const target = path.join(dir, backupFileName(a));
      await backupSqliteDatabase(a, target);
      const check = await verifySqliteBackup(target);
      if (!check.ok) {
        console.error(
          `backup written but failed verification: ${check.integrity.join("; ")}`,
        );
        return 1;
      }
      const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
      const encrypted = encryptionKey
        ? await encryptBackupFile(target, encryptionKey)
        : undefined;
      const pruned = pruneBackups(dir, a, retentionMs(c));
      console.log(
        JSON.stringify({
          backup: target,
          encrypted,
          tables: check.tables,
          pruned,
        }),
      );
      return 0;
    }
    case "encrypt": {
      if (!a) break;
      const encryptionKey = process.env.BACKUP_ENCRYPTION_KEY;
      if (!encryptionKey) {
        console.error("BACKUP_ENCRYPTION_KEY is not set");
        return 1;
      }
      const encrypted = await encryptBackupFile(a, encryptionKey);
      console.log(JSON.stringify({ encrypted }));
      return 0;
    }
    case "verify": {
      if (!a) break;
      const check = await verifySqliteBackup(a);
      console.log(JSON.stringify(check));
      return check.ok ? 0 : 1;
    }
    case "restore": {
      if (!a || !b) break;
      const check = await restoreSqliteDatabase(a, b);
      console.log(
        JSON.stringify({ restored: b, from: a, tables: check.tables }),
      );
      return 0;
    }
    case "prune": {
      if (!a || !b) break;
      console.log(
        JSON.stringify({ pruned: pruneBackups(b, a, retentionMs(c)) }),
      );
      return 0;
    }
    case "migrate": {
      if (!a) break;
      const db = await openSqliteDatabase(a);
      try {
        const result = await applySqliteMigrations(
          db,
          getSqliteMigrationsForDatabase(a, b),
        );
        console.log(JSON.stringify({ database: a, ...result }));
        return 0;
      } finally {
        await new Promise<void>((resolve, reject) =>
          db.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
    case "rollback": {
      if (!a || !b) break;
      const target = Number(b);
      if (!Number.isInteger(target) || target < 0) {
        console.error(`invalid target version: ${b}`);
        return 2;
      }
      const db = await openSqliteDatabase(a);
      try {
        const result = await rollbackSqliteMigrations(
          db,
          getSqliteMigrationsForDatabase(a, c),
          target,
        );
        console.log(JSON.stringify({ database: a, ...result }));
        return 0;
      } finally {
        await new Promise<void>((resolve, reject) =>
          db.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
    case "status": {
      if (!a) break;
      const db = await openSqliteDatabase(a);
      try {
        const version = await getCurrentSchemaVersion(db);
        console.log(JSON.stringify({ database: a, currentVersion: version }));
        return 0;
      } finally {
        await new Promise<void>((resolve, reject) =>
          db.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
    case "integrity": {
      if (!a) break;
      const db = await openSqliteDatabase(a);
      try {
        const check = await runIntegrityCheck(db);
        console.log(JSON.stringify(check));
        return check.ok ? 0 : 1;
      } finally {
        await new Promise<void>((resolve, reject) =>
          db.close((error) => (error ? reject(error) : resolve())),
        );
      }
    }
  }
  console.error(
    "usage: db-backup <backup|verify|restore|prune|migrate|rollback|status|integrity> ... " +
      "(see docs/oracle-db-recovery.md)",
  );
  return 2;
}

const invoked = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (
  invoked.endsWith(`${path.sep}db-backup.ts`) ||
  invoked.endsWith(`${path.sep}db-backup.js`)
) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    },
  );
}
