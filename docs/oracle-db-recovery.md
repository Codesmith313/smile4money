# Oracle Database Recovery

How the oracle's durable data is backed up, how much can be lost, how long recovery takes, and how to restore. The restore is rehearsed automatically by `apps/backend/tests/store/sqlite-backup-restore.test.ts` on every CI run, including restoring from an encrypted backup.

## Automated backup service

`apps/backend/src/store/backup-scheduler.ts` runs the backups on a schedule inside the backend process. It snapshots every protected database, encrypts each snapshot at rest, prunes past the retention window, and alerts (logs an error and increments the failure counter) when a run fails. The manual CLI below remains available for ad-hoc backups and restores.

### Configuration

| Variable | Default | Purpose |
|---|---|---|
| `BACKUP_ENABLED` | `true` | Set to `false` to disable the scheduler (e.g. in local dev). |
| `BACKUP_DIR` | `apps/backend/data/backups` | **Backup location.** Directory where encrypted snapshots are written. Point this at a mounted volume or synced directory. |
| `BACKUP_INTERVAL_MS` | `3600000` (1 hour) | How often the scheduled backup runs. |
| `BACKUP_RETENTION_DAYS` | `35` | Backups older than this are pruned after each run. |
| `BACKUP_ENCRYPTION_KEY` | *(none)* | Secret used to encrypt backups at rest (AES-256-GCM). **Required** when `BACKUP_ENABLED` is true; the scheduler refuses to start without it. |

The scheduler backs up both `oracle-queue.db` and `match-store.db` on each run.

### Encryption at rest

- Each snapshot is encrypted with AES-256-GCM using a key derived from `BACKUP_ENCRYPTION_KEY`.
- Encrypted files are named `<database>.<UTC time>.db.enc` and carry the IV and auth tag alongside the ciphertext. A tampered or truncated file fails authentication on decrypt.
- Store `BACKUP_ENCRYPTION_KEY` in the platform's secret manager, **not** in the repo or the backup directory. Losing the key means the backups cannot be restored.
- Because files are already encrypted, the off-host copy step does not need to add its own encryption (though it may).
=======

## What is protected

| Database | Default path | Contents | Why it matters |
|---|---|---|---|
| `oracle-queue.db` | `apps/backend/data/oracle-queue.db` | `oracle_dlq`: result submissions that failed and are waiting to be retried | Each row is a **pending settlement**. Losing it means a finished game is never submitted, and the players must fall back to `claim_timeout`. |
| `match-store.db` | `apps/backend/data/match-store.db` | Match records: players, usernames, stake, game ID, platform | Needed to verify player identities before a result is submitted. |

The chain is the source of truth for funds and match state. These databases hold work in progress that the chain does not know about yet. That is exactly what a backup has to save.

Rate-limit and circuit-breaker databases hold short-lived counters that rebuild on their own. They are not backed up.

## Objectives

| Objective | Target | How it is met |
|---|---|---|
| **Backup frequency** | Every hour, plus before every deploy | Scheduled `db-backup backup` (below) |
| **Recovery point (RPO)** | At most **1 hour** of new entries lost | Hourly online snapshots |
| **Recovery time (RTO)** | Service accepting work again within **30 minutes** of the decision to restore | Restore is one command; the databases are small |
| **Retention** | **35 days**, and always at least the newest backup | `pruneBackups`, run after every backup |
| **Rehearsal** | Every CI run (automated), plus a manual drill each quarter | `sqlite-backup-restore.test.ts`; drill steps below |

**What a 1-hour RPO means in practice.** A settlement that entered the queue after the last backup is lost on restore. The match stays `Active` or `PendingResult` on-chain, so nothing is paid out wrongly. Operators re-submit the result once the oracle is back; see *After a restore* below. If the result can't be recovered, both players can reclaim their stakes with `claim_timeout` after the on-chain timeout (about 7 days).

## Taking backups

`apps/backend/src/cli/db-backup.ts` wraps `apps/backend/src/store/sqlite-backup.ts`:

```sh
cd apps/backend
# Snapshot, verify the snapshot, prune past 35 days. Exits non-zero on failure.
npx tsx src/cli/db-backup.ts backup data/oracle-queue.db /var/backups/oracle
npx tsx src/cli/db-backup.ts backup data/match-store.db  /var/backups/oracle
```

- **Safe while running.** Backups use SQLite's `VACUUM INTO`, which takes a consistent snapshot while the service keeps writing (WAL mode). Each backup is a single self-contained file.
- **Never overwrites.** Files are named `<database>.<UTC time>.db`, and an existing file is never overwritten.
- **Store off-host.** Keep backups off the host: copy `BACKUP_DIR` to object storage after each run. The files are already encrypted at rest; the tables hold usernames and wallet addresses, so restrict access to operators.
- **Alert on failure.** The scheduler logs an error and increments a failure counter when a run fails; wire that counter to your alerting. If you run the CLI manually instead, alert when it exits non-zero.

The scheduler replaces the need for a crontab. If you prefer an external scheduler, disable `BACKUP_ENABLED` and keep the cron entries below:

```cron
0 * * * * cd /srv/smile4money/apps/backend && npx tsx src/cli/db-backup.ts backup data/oracle-queue.db /var/backups/oracle
2 * * * * cd /srv/smile4money/apps/backend && npx tsx src/cli/db-backup.ts backup data/match-store.db /var/backups/oracle
```

## Restoring

1. **Stop the backend** so nothing writes during the restore.
2. **Pick the newest backup** taken before the incident. Scheduled backups are encrypted (`*.db.enc`); decrypt one first, then check it:
   ```sh
   # Decrypt using the same BACKUP_ENCRYPTION_KEY the scheduler used.
   npx tsx src/cli/db-backup.ts decrypt \
     "$BACKUP_DIR/oracle-queue.<time>.db.enc" /tmp/oracle-queue.<time>.db
   npx tsx src/cli/db-backup.ts verify /tmp/oracle-queue.<time>.db
   ```
   `decrypt` fails if the file was tampered with or the key is wrong. `verify` must report `"ok": true`; the `tables` field shows the row counts. (Backups taken with the manual CLI are unencrypted and can be verified directly.)
3. **Keep the damaged database**, if it exists, for the post-incident report:
   ```sh
   mv data/oracle-queue.db data/oracle-queue.db.broken
   ```
4. **Restore** from the decrypted file:
   ```sh
   npx tsx src/cli/db-backup.ts restore /tmp/oracle-queue.<time>.db data/oracle-queue.db
   ```
   The backup is verified again first; an unhealthy backup is refused and the target is not touched. The target's stale `-wal`/`-shm` files are removed, so they can't be replayed onto the restored data.
5. **Repeat for `match-store.db`** if it was affected.
6. **Start the backend** and confirm the retry worker picks up the restored DLQ entries (`oracle_dlq: retrying oracle submission` in the logs).

### After a restore

- Anything written after the backup is gone.
- For each match with a finished game but no on-chain result, check it with `get_match` and re-submit through the normal oracle flow.
- Record the backup used, the RPO actually lost, and the time to recover in the post-incident report ([runbook §6](runbook.md#6-post-incident-report-template)).

## Quarterly drill

1. Copy the latest production backup (`*.db.enc`) to a staging host.
2. Run steps 2–6 of *Restoring* there (including `decrypt`), and time them against the 30-minute RTO.
3. Compare the restored `oracle_dlq` count with the count in the backup's `verify` output.
4. Record the result and any problems in the operations log.

The automated rehearsal in `sqlite-backup-restore.test.ts` also covers the encrypted path: it takes a scheduled backup, decrypts it, restores it, and asserts the restored rows match. A green CI run is evidence the restore path works.
