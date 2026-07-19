# GuestPost Production Runbook

Companion to `docs/OPERATIONS.md` (backups, supervision, monitoring basics). This document covers deployment, rollback, and incident response for a money-handling platform.

## 1. Deployment

### Required environment (API fails fast at boot when missing)
| Var | Notes |
|---|---|
| `DATABASE_URL` | include `connection_limit`/`pool_timeout` only to override tuned defaults |
| `REDIS_URL` | API cache, rate limits, and pub/sub |
| `QUEUE_REDIS_URL` | BullMQ; falls back to `REDIS_URL`, but use a separate production database |
| `JWT_SECRET` | 32+ random chars, never a documented default |
| `QUEUE_SIGNING_SECRET` | must differ from JWT_SECRET |
| `TRUSTED_ORIGINS` | comma-separated app origins — **API throws without it in production** |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | deposits |
| `STRIPE_PAYOUT_WEBHOOK_SECRET` | payout webhooks (falls back to STRIPE_WEBHOOK_SECRET) |
| `WISE_API_KEY`, `WISE_WEBHOOK_PUBLIC_KEY` | Wise payouts + webhook verification (fail-closed 503 without) |
| `PAYOUT_ENCRYPTION_KEY` | 32+ chars; payout-details encryption refuses dev-derived key in prod |
| `CORS_ORIGIN` | comma-separated frontend origins |
| `WORKER_MODE` | `realtime` for the continuous service; job modes are documented in `WORKER_ARCHITECTURE.md` |
| `WORKER_ON_DEMAND_TRIGGER_URL`, `WORKER_ON_DEMAND_TRIGGER_TOKEN` | least-privilege Northflank job wake-up; catch-up cron remains mandatory |

### Deploy sequence (zero-surprise order)
1. `git pull` the release tag; `pnpm install --frozen-lockfile`.
2. **Backup first**: `scripts/backup-db.sh /var/backups/guestpost` (verifies dump readability).
3. Migrations: `cd packages/database && npx prisma migrate deploy` — additive migrations only; destructive changes need a two-release expand/contract.
4. `pnpm build` (11 targets; abort on any failure).
5. Follow the hybrid cutover in `docs/WORKER_ARCHITECTURE.md`: deploy the API,
   stop all old worker versions, start the realtime lane, then enable jobs.
6. Verify: `/api/v1/health` 200; realtime worker log shows four queues;
   manually run payout reconciliation and `GET /admin/reconciliation`.
7. Watch the reconciliation sweep for one cycle before calling it done.

Container path: `docker build -f apps/api/Dockerfile .` / `apps/worker/Dockerfile` from repo root; same env contract; compose healthcheck hits `/api/v1/health`.

### CRITICAL: exactly one worker code version
Realtime and short-lived job modes may overlap only when they use the same
immutable image tag. A stale worker can consume a job with old logic and
silently swallow it. Deployments must replace versions, never accumulate them.

Deployment verification:

1. **Replica count** — Verify exactly one worker fleet:
   - K8s/Swarm/Nomad: check desired vs. actual replica count via orchestrator
   - Laptop/bare-metal: `pgrep -f 'worker/dist' | wc -l` matches expected count

2. **Health** — Each replica must pass:
   - `curl -f http://worker:3004/health` → 200 (process alive)
   - `curl -f http://worker:3004/ready`  → 200 (Redis + Postgres connected)

3. **Queue metrics** — Verify no signals of trouble:
   - `curl -s http://worker:3004/metrics/queues` → `stalledHitsTotal` === 0
   - Active/waiting/failed counts are within expected range

4. **Smoke tests** — Exercise the financial flow end-to-end:
   - Settlement sweep completes successfully (check `GET /admin/reconciliation` → `ok: true`)
   - No new failed jobs appear (check `/metrics/queues` before and after)
   - Queue metrics remain healthy
   - Test payout reaches expected state or is correctly blocked by policy
   - No WARN/ERROR entries related to settlements or payouts in structured logs

### Post-deploy checklist

```
After every deployment:

□ API healthy       (curl -f http://api:3000/api/v1/health)
□ Worker healthy    (curl -f http://worker:3004/health)
□ Worker ready      (curl -f http://worker:3004/ready)
□ Queue metrics     (curl -s http://worker:3004/metrics/queues → stalledHitsTotal === 0)
□ No stalled jobs
□ Redis connected   (covered by /ready)
□ Database connected (covered by /ready)
□ One worker version deployed (orchestrator or pgrep)
□ Smoke: settlement sweep completes (GET /admin/reconciliation → ok: true)
□ Smoke: payout request reaches expected state or is correctly blocked
```

## 2. Rollback

1. Application rollback: check out previous tag, `pnpm install --frozen-lockfile && pnpm build`, restart worker→API.
2. Migration rollback: **never roll back a migration with financial data written under it.** Roll the application back only — schema stays. All recent migrations are additive.
3. After any rollback run reconciliation; investigate any drift before reopening traffic.

## 3. Database restore

Follow `docs/OPERATIONS.md` restore drill. Additional money-platform steps:
- Quantify the gap: compare latest `Transaction.createdAt` in the restored DB to the incident time; every later provider event must be replayed or manually reconciled.
- Stripe events: redeliver from Stripe dashboard (deposits/disputes are idempotent — unique `Transaction.reference` makes replays safe).
- Wise: compare provider transfer list against `PayoutExecution` rows for the gap window; reconcile via retry/recovery (`PAYOUT_EXECUTION_RECOVERED_COMPLETED` path) — never re-send blindly.
- Freeze payout execution at the finance API/permissions layer or revoke
  provider keys. Stopping the worker only pauses reconciliation; workers do not
  initiate transfers.

## 4. Incident response

### Severity ladder
- **SEV1**: money drift detected, double payout suspected, data breach. Freeze payouts + deposits (maintenance mode), page everyone.
- **SEV2**: provider outage, stuck payout queue, API down.
- **SEV3**: degraded UX, single-feature failure.

### First 15 minutes (SEV1 financial)
1. `GET /admin/reconciliation` — capture the full report (it's also in the audit log under `RECONCILIATION_DRIFT_DETECTED`).
2. Disable the staff payout-execute endpoint/finance role and pause payout jobs.
   Stopping workers alone does not halt API-initiated transfers.
3. Disable deposits if wallet-side: unset `STRIPE_WEBHOOK_SECRET`? **No** — never break signature verification; instead pause at Stripe dashboard (disable the webhook endpoint) so retries queue on Stripe's side.
4. Snapshot: `scripts/backup-db.sh` immediately (evidence + recovery point).
5. Trace with the audit log: every money mutation has an audit row with actor/metadata; `Transaction.reference` uniqueness tells you exactly what executed.

### Provider outage
- **Stripe down**: deposits fail at checkout (user-visible, no money risk). Disputes/webhooks queue on Stripe side and redeliver — idempotent handlers absorb the burst.
- **Wise down**: executions fail → withdrawals FAILED → publishers see status.
  If no provider transfer ID was recorded, do not retry until the original
  idempotency key is reconciled in Wise. Scheduled polling resumes automatically.
- **Queue Redis down**: realtime/on-demand BullMQ work pauses. Payout webhooks
  still commit to the Postgres inbox and return 2xx; payout reconciliation
  catches up after Redis/job recovery. Other queued API work fails at enqueue.
- **Postgres down**: everything fails closed. Restore service, then run reconciliation before reopening.

### Chargeback handling
Automatic: hold placed on dispute.created (funds frozen), release on won/warning_closed, debit on lost — all audited (`STRIPE_CHARGEBACK_*`). Manual duties: respond in Stripe dashboard within the evidence window; for `UNLINKED` alerts (deposit not found) reconcile manually before the window closes; track chargeback rate (>0.75% threatens the Stripe account).

### Financial incident (drift confirmed)
1. Identify scope from reconciliation deltas (wallet vs publisher vs lifetimePaid).
2. Every legitimate balance change has a Transaction row; drift means a mutation bypassed the ledger — find it via audit log + `updatedAt` on the drifted row.
3. Correct via compensating Transaction rows + balance adjustment in ONE manual SQL transaction, documented in an audit row (`action: MANUAL_CORRECTION`, metadata: incident id) — never silent UPDATEs.
4. Re-run reconciliation to prove zero drift; post-mortem with the audit trail.

## 5. Clean-environment bring-up checklist
1. Postgres + Redis up (compose healthchecks green).
2. `npx prisma migrate deploy` (creates full schema incl. CHECK constraints/partial indexes from the squashed baseline).
3. `pnpm seed` for staging; production starts empty — first SUPER_ADMIN is provisioned via DB insert into `StaffMembership` (documented bootstrap, no self-promote API by design).
4. API boots only with the full env contract (above) — missing vars are an immediate, loud failure, not a degraded state.
5. Realtime worker boots; Northflank scheduled jobs and the on-demand catch-up
   cron are enabled per `docs/WORKER_ARCHITECTURE.md`.
6. Smoke: health 200 → sign-up → org-create → deposit via Stripe test → reconciliation `ok: true`.

## Appendix: container build status (2026-06-12)
`apps/api/Dockerfile` and `apps/worker/Dockerfile` are validated through the
dependency-install stage (pnpm v11 `allowBuilds` approvals in
pnpm-workspace.yaml + `.dockerignore` excluding host node_modules are both
required — see git history for the failure modes). The final compile stage
exceeded the local Docker Desktop VM's memory allowance
(`ResourceExhausted` during prisma generate + tsc). Action before first
containerized deploy: run the build on a host/CI runner with ≥4 GB available
to Docker and smoke the image (`node apps/worker/dist/index.js` must
fail-fast on missing env, not crash). pm2-on-VM (documented above) is the
validated beta deployment path.
