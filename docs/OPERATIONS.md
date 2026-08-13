# GuestPost Platform — Operations Runbook (Beta)

Minimum operational readiness for running the platform with real money.

The canonical money contract is `docs/FINANCIAL_INVARIANTS.md`. Reusable
read-only incident and release queries are in
`docs/FINANCIAL_INCIDENT_QUERIES.md`.

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

## Delivery evidence object storage

Production must set `OBJECT_STORAGE_PROVIDER` explicitly to `r2` or `s3`.
R2 requires `R2_ACCOUNT_ID`, `R2_ENDPOINT`, `R2_BUCKET`, `R2_ACCESS_KEY_ID`, and
`R2_SECRET_ACCESS_KEY`. S3 requires `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY`,
and `S3_SECRET_KEY`; `S3_ENDPOINT` is optional for AWS and must be HTTPS when
set. `R2_ACCOUNT_ID` must be the 32-hex account ID and `R2_ENDPOINT` must equal
`https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com`; custom or cross-account
hosts are rejected. The selected provider's bucket is operator-created and
retained for legal and dispute evidence.

Provision `.guestpost/evidence-storage-ready-v1` in that bucket before rollout
and retain it. The API and storage-capable worker lanes perform a bounded,
read-only `HeadObject` against it before accepting work. A missing object,
unreachable endpoint, or insufficient read permission fails startup. The
application never creates or deletes production buckets or this sentinel.
`HeadObject` does not prove that the runtime role can persist new evidence.
Before opening delivery or Finance lanes in staging or production, use the
exact runtime credentials for an audited upload-and-retrieve canary, verify the
retrieved checksum, and remove only that canary object according to the
retention policy. A failed write/read canary blocks rollout even when startup
readiness is green.

The API and every worker lane that can consume delivery-verification jobs need
the selected bundle. On the hybrid worker layout, that means `realtime` and
legacy `all`, plus the `settlement-link-check` and
`delivery-verification-dispatch` scheduled tasks. Do not grant these credentials
to unrelated on-demand or scheduled lanes. Update secret storage before
rolling out an image that requires a new provider selector.

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

In the hybrid production layout, Northflank's five-minute maintenance job runs
the financial drift sweep at minute 30 of every hour
(`WORKER_MODE=scheduled`, `WORKER_TASK=maintenance-dispatch`). A direct
`WORKER_TASK=reconciliation` run remains available for incident response.
`WORKER_MODE=all` retains the legacy BullMQ repeatable sweep for local fallback.
The Northflank cron controls hybrid cadence; `RECONCILIATION_SWEEP_MINUTES`
only tunes the compatibility scheduler (minimum 5). Checks: wallet drift,
publisher balance drift, stuck DELIVERED orders, stuck/duplicate payouts,
lifetimePaid drift — same core as `GET /admin/reconciliation`.

`FINANCE_RUNTIME_MODE` is the cross-process incident/deployment policy.
Production must set it explicitly. `recovery_only` keeps payout/dispute inbox
processing, exact provider polling, and reconciliation active but rejects new
wallet liabilities, settlement mutations, withdrawal decisions, external
sends, and manual completion. `locked` accepts durable inbound evidence while
pausing recovery mutations. Invalid or missing production configuration fails
closed to `locked`.

On ANY finding it:
1. writes an `RECONCILIATION_DRIFT_DETECTED` audit row with the full report,
2. sends an in-app notification to every staff member
   (`RECONCILIATION_ALERT`).

Staff should treat that alert as a page. Drill-down: admin → Finance →
Reconciliation tab, or `GET /api/v1/admin/reconciliation`.

## Runbook: chargeback received

Automatic (on `charge.dispute.created`):
- a durable provider-neutral dispute case is claimed by Stripe dispute ID;
- amount/currency and the originating deposit PaymentIntent are validated;
- the available portion moves to a hold owned by that case and uncovered
  exposure is stored as a structured shortfall;
- wallet spend and dispute booking share one row lock; a new reservation fails
  with `409 WALLET_SPEND_BLOCKED_BY_DISPUTE` while any `OPEN` or `LOST` case has
  positive current exposure;
- case, wallet, ledger, audit, and event processing commit atomically;
- replay returns the same case only when immutable facts match.

Manual follow-up:
1. Respond to the dispute in the Stripe dashboard within the evidence window.
2. On `charge.dispute.closed` the platform auto-resolves:
   - **won** → hold released back to available (`STRIPE_CHARGEBACK_WON_RELEASED`)
   - **lost** → hold debited permanently with a `CHARGEBACK` ledger row
     (`STRIPE_CHARGEBACK_LOST_DEBITED`)
3. A complete verified close-before-open event may create a terminal case
   directly. Unsupported, contradictory, incomplete, or currency-mismatched
   events must remain failed/retryable and alert Finance. Do not acknowledge
   them as a successful money transition.
4. A `WON` outcome clears current exposure and permits new reservations. A
   `LOST` shortfall remains spend-blocking even after later deposits or refunds.
   No automatic credit sweep/recovery allocation exists; use a reviewed future
   recovery/netting workflow, never a direct exposure or wallet edit.
5. For an unlinked case, retrieve canonical Stripe dispute/payment state,
   identify the funding record, and repair through the incident-linked
   idempotent compensation command. Do not update wallet balances directly.

Incident evidence queries must establish:

- every processed dispute-open inbox event has one dispute case;
- every open linked case has its owned hold;
- held plus shortfall equals provider-disputed amount;
- every wallet with positive open/lost exposure rejects new reservations;
- every terminal case has exactly one matching resolution;
- no case has both won/released and lost/debited outcomes.

## Runbook: failed or ambiguous withdrawal

A provider error does not prove that money stayed put. The withdrawal remains
reserved in a recovery/review stage until authenticated provider evidence
establishes paid, processing, failed, or safely cancelled truth.

Options (admin → Finance → Withdrawals):

1. **Reconcile** (`POST /admin/payout-executions/:id/retry`) retrieves the
   persisted provider object. It never creates a replacement payout with a new
   identity. A Stripe Transfer whose bank-payout stage never started may resume
   only with the original stable bank-payout idempotency key.
2. **Cancel/reverse provider movement** is available only where the adapter can
   return complete terminal evidence. Stripe Connect must prove the bank Payout
   is cancelled/failed and the exact Transfer is reversed before the local
   execution becomes `CANCELLED` and the withdrawal returns to `APPROVED`.
3. The legacy generic withdrawal-reversal command fails closed with
   `PAYOUT_REVERSAL_EVIDENCE_REQUIRED`. A local `FAILED` label, staff reason,
   timeout, or missing provider reference is not enough to restore funds.
   Legacy rows remain reserved pending provider/bank reconciliation or a
   separately reviewed, typed compensating command.

Finance UI safeguards are part of this runbook contract. Approval opens a
confirmation dialog. Execute requires the exact withdrawal public reference
and a 10–500 character rationale. Retry/recover and cancel/resume require the
displayed `RETRY` or `CANCEL` token plus the same bounded rationale. The API
validates the rationale again, and the payout service records it after current
actor revalidation. Treat these reasons as internal audit evidence only; never
copy them into provider descriptions, metadata, or transfer instructions.

Finance cannot use a generic Mark Paid override for an approved or automated
withdrawal. Automated completion comes from verified provider evidence. A
manual route, when enabled, can complete only an existing in-flight manual
execution with the required immutable payment evidence and actor separation.
Before submission the dialog shows the publisher, amount/currency, withdrawal
public reference, and execution ID and requires the operator to type that exact
reference. The server compares it with the locked Withdrawal row; a legacy
missing reference or mismatch is an audited conflict with no liability change.

## Runbook: customer wallet return request

Customer wallets are closed-loop and do not support cash withdrawal. Support
must not simulate a return with a wallet debit, payout, or direct SQL.

If a customer requests funds returned externally:

1. preserve the wallet and funding history;
2. identify eligible original funding sources and any amounts already spent,
   refunded, reserved, or disputed;
3. escalate to Finance for the approved original-source return workflow;
4. if that workflow is not enabled, communicate that the wallet remains usable
   on-platform and record the support case.

An external return feature requires its own aggregate, source allocation,
provider execution, terminal evidence, and reconciliation before it may be
enabled.

## Required env vars (production)

Fail-fast at boot: `DATABASE_URL`, `QUEUE_REDIS_URL` (or `REDIS_URL` fallback), `JWT_SECRET`,
`QUEUE_SIGNING_SECRET` (must differ from JWT_SECRET).

`PAYOUT_EXECUTION_ENABLED` is the global new-send gate. Production treats it as
disabled unless explicitly `true`; keep recovery, verified webhook ingestion,
status polling, reconciliation, and safe cancellation available for in-flight
money.
Payments: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`,
`STRIPE_DEPOSITS_ENABLED`.
Payouts: separate `STRIPE_PAYOUT_WEBHOOK_SECRET`,
`STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET`, `STRIPE_CONNECT_ENABLED`,
`WISE_WEBHOOK_PUBLIC_KEY`, `WISE_API_KEY`, `PAYOUT_ENCRYPTION_KEYS`, and
`PAYOUT_ENCRYPTION_ACTIVE_KEY_ID`. `PAYOUT_ENCRYPTION_KEY` is legacy-read-only
during the v2 rotation window; see `docs/PAYOUT_ENCRYPTION_RUNBOOK.md`.
Missing payout webhook config fails closed (503, never enqueued).

### Signed webhook ingress limits

The four canonical provider callback routes have a dedicated, per-IP
one-minute ingress budget:

- `POST /api/v1/billing/webhook/stripe`
- `POST /api/v1/payout-webhooks/stripe_connect/platform`
- `POST /api/v1/payout-webhooks/stripe_connect/connected`
- `POST /api/v1/payout-webhooks/wise`

The staging/production default is 600 requests per source IP per minute
(development: 5,000). `WEBHOOK_INGRESS_RATE_LIMIT_MAX` can tune the budget from
1 through 10,000; invalid values fall back to the environment default. These
exact routes skip the general anonymous/authenticated fallback only after being
counted by the dedicated limiter. Near-prefix paths, other methods, and the
retired shared Stripe route remain subject to the ordinary API limits.

This limiter is an availability boundary, not authentication. Stripe/Wise
signature validation, replay checks, event allowlists, and raw-body
verification remain mandatory, and invalid signed-route attempts consume the
same finite budget. Monitor webhook `429` responses and provider retries before
raising the limit; never disable the limiter or add a prefix-based exemption.
