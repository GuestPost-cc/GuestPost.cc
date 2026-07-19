# GuestPost Platform — Operations Runbook (Beta)

Minimum operational readiness for running the platform with real money.

## Processes

| Process | Command | Port |
|---|---|---|
| API | `node apps/api/dist/main.js` | 4000 |
| Worker | `node apps/worker/dist/index.js` | `WORKER_MODE` selects realtime/on-demand/scheduled/all |
| Website | `next start apps/website` | 3000 |
| Portal | `next start apps/portal` | 3001 |
| Publisher | `next start apps/publisher` | 3002 |
| Admin | `next start apps/admin` | 3003 |

Infrastructure (Postgres, Redis, MinIO, Traefik, Mailpit) runs via
`pnpm services:up` (docker compose, all services `restart: unless-stopped`).

### Process supervision (pm2)

```bash
npm i -g pm2
pm2 start apps/api/dist/main.js    --name gp-api    --env NODE_ENV=production
pm2 start apps/worker/dist/index.js --name gp-worker --env NODE_ENV=production
pm2 save && pm2 startup   # survive server reboot
```

Both processes fail fast on boot if Postgres/Redis are unreachable or
required env vars are missing — pm2 restarts them with backoff.

## Backups

### Nightly dump

```bash
# crontab -e (as the deploy user)
0 3 * * * /path/to/guestpost-platform/scripts/backup-db.sh /var/backups/guestpost >> /var/log/guestpost-backup.log 2>&1
```

`scripts/backup-db.sh`:
- `pg_dump --format=custom --compress=9` from the `gp-postgres` container
- verifies readability with `pg_restore --list`
- prunes dumps older than `RETENTION_DAYS` (default 14)
- non-zero exit on any failure (cron mail / alerting hooks catch it)

Copy dumps offsite (object storage, separate machine) — a backup on the same
disk as the database is not a backup.

### Restore procedure

```bash
# 1. Stop API + worker so nothing writes
pm2 stop gp-api gp-worker

# 2. Restore into a FRESH database first and inspect it
docker exec -i gp-postgres createdb -U guestpost guestpost_restore
docker exec -i gp-postgres pg_restore -U guestpost -d guestpost_restore --no-owner < guestpost_YYYYMMDD_HHMMSS.dump

# 3. Sanity-check financial tables
docker exec gp-postgres psql -U guestpost -d guestpost_restore -c 'SELECT count(*) FROM "Transaction";'

# 4. Swap: rename databases (or point DATABASE_URL at the restore)
# 5. Restart, then IMMEDIATELY run reconciliation:
curl -H "Authorization: Bearer <staff-token>" http://localhost:4000/api/v1/admin/reconciliation

# 6. pm2 start gp-api gp-worker
```

Run a restore drill before the first real customer. An untested restore
procedure does not exist.

## Health monitoring

- `GET /api/v1/health` — API liveness (registered before rate limiting).
  Point an uptime monitor (UptimeRobot, Healthchecks.io, etc.) at it.
- Worker liveness: `pm2 status gp-worker`; worker logs say
  `[WORKER] Started 6 workers` on boot.
- Queue depth: BullMQ keys live in Redis (`redis-cli keys 'bull:*:wait'`).

## Automated reconciliation + alerting

In the hybrid production layout, Northflank runs the financial drift sweep
every 60 minutes (`WORKER_MODE=scheduled`, `WORKER_TASK=reconciliation`).
`WORKER_MODE=all` retains the legacy BullMQ repeatable sweep for local fallback.
The Northflank cron controls hybrid cadence; `RECONCILIATION_SWEEP_MINUTES`
only tunes the compatibility scheduler (minimum 5). Checks: wallet drift,
publisher balance drift, stuck DELIVERED orders, stuck/duplicate payouts,
lifetimePaid drift — same core as `GET /admin/reconciliation`.

On ANY finding it:
1. writes an `RECONCILIATION_DRIFT_DETECTED` audit row with the full report,
2. sends an in-app notification to every staff member
   (`RECONCILIATION_ALERT`).

Staff should treat that alert as a page. Drill-down: admin → Finance →
Reconciliation tab, or `GET /api/v1/admin/reconciliation`.

## Runbook: chargeback received

Automatic (on `charge.dispute.created`):
- the disputed amount is held (wallet available → reserved) on the
  originating wallet, linked via the deposit's `payment_intent`
- audit row `STRIPE_CHARGEBACK_HOLD_PLACED` (or `..._UNLINKED` when the
  deposit can't be found — manual review required)
- every staff member is notified, including any uncovered exposure
  (deposit partially spent before the dispute arrived)

Manual follow-up:
1. Respond to the dispute in the Stripe dashboard within the evidence window.
2. On `charge.dispute.closed` the platform auto-resolves:
   - **won** → hold released back to available (`STRIPE_CHARGEBACK_WON_RELEASED`)
   - **lost** → hold debited permanently with a `CHARGEBACK` ledger row
     (`STRIPE_CHARGEBACK_LOST_DEBITED`)
3. If the chargeback was UNLINKED, reconcile manually: find the deposit,
   freeze the org (support action), and adjust via finance review.

## Runbook: failed withdrawal

A withdrawal whose payout execution hard-failed sits in `FAILED` with the
publisher's funds already deducted.

Options (admin → Finance → Withdrawals):
1. **Retry** (`POST /admin/payout-executions/:id/retry`) — checks the
   provider's actual transfer status first; safe against double-pay.
2. **Reverse** (`POST /admin/withdrawals/:id/reverse`, reason required) —
   returns the funds to the publisher's withdrawable balance
   (`FAILED → REVERSED`, `WITHDRAWAL_REVERSAL` ledger row). Refused while any
   execution is COMPLETED/PROCESSING (money may have actually moved).

## Required env vars (production)

Fail-fast at boot: `DATABASE_URL`, `QUEUE_REDIS_URL` (or `REDIS_URL` fallback), `JWT_SECRET`,
`QUEUE_SIGNING_SECRET` (must differ from JWT_SECRET).
Payments: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`.
Payouts: `STRIPE_PAYOUT_WEBHOOK_SECRET` (falls back to `STRIPE_WEBHOOK_SECRET`),
`WISE_WEBHOOK_PUBLIC_KEY`, `WISE_API_KEY`, `PAYOUT_ENCRYPTION_KEY`.
Missing payout webhook config fails closed (503, never enqueued).
