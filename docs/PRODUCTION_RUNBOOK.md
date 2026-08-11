# GuestPost Production Runbook

Companion to `docs/OPERATIONS.md` (backups, supervision, monitoring basics). This document covers deployment, rollback, and incident response for a money-handling platform.

## 1. Deployment

### Required environment and fail-closed controls

Most missing production secrets stop the relevant process or provider lane at
boot. `FINANCE_RUNTIME_MODE` is intentionally different: a missing or invalid
value resolves to `locked`, preserving read-only access and signed inbound
evidence while refusing money mutations.

| Var | Notes |
|---|---|
| `DATABASE_URL` | Real credentials are API/worker-only and use the least-privilege runtime DML role; must not own the schema/tables or have DDL, trigger, superuser, or `BYPASSRLS` authority. A frontend build may receive only the committed unreachable loopback placeholder needed by workspace Prisma generation, never a live credential. |
| `DIRECT_DATABASE_URL` | isolated deploy/migration job only; schema-owner credential, never injected into API/worker/frontend/job runtimes |
| `REDIS_URL` | API cache, rate limits, and pub/sub |
| `QUEUE_REDIS_URL` | BullMQ; falls back to `REDIS_URL`, but use a separate production database |
| `JWT_SECRET` | 32+ random chars, never a documented default |
| `QUEUE_SIGNING_SECRET` | must differ from JWT_SECRET |
| `TRUSTED_ORIGINS` | comma-separated app origins — **API throws without it in production** |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | Stripe deposits; prefer a least-privilege `rk_*` key whose mode matches the webhook |
| `STRIPE_PAYOUT_WEBHOOK_SECRET` | Stripe platform-transfer route (`/payout-webhooks/stripe_connect/platform`) secret; no fallback/reuse |
| `STRIPE_CONNECTED_PAYOUT_WEBHOOK_SECRET` | separate connected-account route (`/payout-webhooks/stripe_connect/connected`) secret; required with Connect |
| `STRIPE_DEPOSITS_ENABLED`, `STRIPE_CONNECT_ENABLED` | direction/provider gates; false unless deliberately enabled |
| `PAYOUT_EXECUTION_ENABLED` | global gate for **new payout sends**; production defaults off unless explicitly `true`; recovery, polling, verified webhooks, and evidence-backed cancellation remain available |
| `FINANCE_RUNTIME_MODE` | required in production: `normal`, `recovery_only`, or `locked`; missing/invalid values fail closed to `locked` |
| `STRIPE_LIVE_MODE_ENABLED` | must remain false for test keys/staging; live-key boot gate |
| `NEXT_PUBLIC_PORTAL_URL`, `NEXT_PUBLIC_PUBLISHER_URL` | exact HTTPS, credential-free return origins; required when the corresponding Stripe flow is enabled in production |
| `PAYOUT_LEGACY_METHODS_ENABLED` | false for Stripe rollout; only enable after the selected legacy provider is certified |
| `WISE_API_KEY`, `WISE_WEBHOOK_PUBLIC_KEY` | Reserved for Wise certification/webhook verification; automated Wise sends remain disabled until typed settlement and recovery evidence are approved |
| `PAYOUT_ENCRYPTION_KEY` | Exactly 64 hexadecimal characters (32 bytes); malformed configured keys fail startup in every environment, and payout-details encryption refuses the dev-derived fallback in production |
| `INTEGRATION_ENCRYPTION_KEY` | Legacy integration-token key registered as version 1; exactly 64 hexadecimal characters; mutually exclusive with the keyring variables |
| `INTEGRATION_ENCRYPTION_KEYS` | Bounded JSON object mapping positive integer versions to distinct exact 64-hex keys; production rotation mode; an explicitly empty value is invalid |
| `INTEGRATION_ENCRYPTION_ACTIVE_VERSION` | Highest version present in `INTEGRATION_ENCRYPTION_KEYS`, and at least 2; all new OAuth/token-refresh writes use it |
| `OBJECT_STORAGE_PROVIDER`, selected `R2_*`/`S3_*` bundle | Delivery-evidence storage; R2 requires a 32-hex `R2_ACCOUNT_ID` and its exact canonical endpoint. Provision the fixed `.guestpost/evidence-storage-ready-v1` object before rollout; API and delivery-capable workers must pass the bounded read-only startup check. This check does not prove write permission: an audited upload/retrieve/checksum canary with the exact runtime role is a separate release gate. |
| `CORS_ORIGIN` | comma-separated frontend origins |
| `WEBHOOK_INGRESS_RATE_LIMIT_MAX` | optional exact signed-webhook per-IP/minute cap; production default 600, valid range 1..10,000; never use a prefix exemption |
| `WORKER_MODE` | `realtime` for the continuous service; job modes are documented in `WORKER_ARCHITECTURE.md` |
| `WORKER_ON_DEMAND_TRIGGER_URL`, `WORKER_ON_DEMAND_TRIGGER_TOKEN` | least-privilege Northflank job wake-up; catch-up cron remains mandatory |

`WEBHOOK_INGRESS_RATE_LIMIT_MAX` is pre-verification per-IP DoS protection,
not webhook authentication. It applies only to the four canonical POST paths
listed in `docs/OPERATIONS.md`; controller signature, replay, allowlist, and
raw-body checks remain authoritative. Monitor provider `429` responses and
retry telemetry before tuning the 600/minute staging/production default.

### Payout encryption rotation boundary

`CURRENT_PAYOUT_KEY_VERSION` supports a soft rotation only: increment the
version while retaining the exact same `PAYOUT_ENCRYPTION_KEY`. The runtime
derives and can read every version from `0` through the current version. Before
and after a soft bump, run:

```bash
pnpm tsx scripts/verify-encryption-versions.ts --decrypt
```

The verifier checks active and inactive payout records, samples real
payout-method decryption, and validates every provider config without printing
plaintext. `PayoutProvider.config` may be an empty `{}` only when credentials
come from the process environment; every non-empty provider config must be
authenticated ciphertext. Any unknown version, plaintext non-empty config, or
decrypt failure blocks deployment.

A hard master-key replacement is not currently supported because the runtime
has no dual-key reader or reviewed re-encryption command. Never directly
replace or erase the production master key: doing so makes historical
ciphertext unreadable. If compromise is suspected, set
`FINANCE_RUNTIME_MODE=locked`, disable payout sends and decrypt permission,
preserve the old key in the incident vault, and require a separately reviewed
dual-key/keyring migration with complete verification and rollback rehearsal.
The detailed engineering contract is in
`bedrock/Memory/infrastructure.md#payout-encryption-key-rotation`.

### Integration OAuth-token key rotation

`ExternalAccount.encryptionKeyVersion` identifies the master-key entry used
for both authenticated token ciphertexts. Decrypt never guesses a version.
Version 2+ envelopes carry a database-readable version prefix and AES-GCM
additional authenticated data binds each ciphertext to the immutable account
provider/external-user/owner identity and to its access-versus-refresh purpose.
The database rejects version relabeling, one-sided rotation, version decrease,
and a stale unprefixed v1 writer targeting a v2+ row. Use this sequence for a
hard rotation:

Before applying `20260802093000`, validate the **currently deployed** legacy
secret in the secret manager without printing or copying it into build logs.
The former runtime accepted any value of at least 64 characters and passed its
first 64 characters to Node's hex decoder, which could silently stop at
non-hex material:

- Exactly 64 hexadecimal characters: register that material as v1 and proceed.
- More than 64 characters with an all-hex first 64: normalize v1 to exactly
  those first 64 characters, then prove every row decrypts with `--verify-only`.
- Any non-hex character within the first 64: stop the cutover. Never pad,
  reinterpret, or guess the key. Preserve the secret and ciphertext backup,
  keep Google metrics quarantined, and use a separately reviewed isolated
  remediation or require affected owners to reconnect OAuth. Only after
  preserving incident evidence may an unreadable account be moved to the
  documented `ERROR` + two-empty-token sentinel for reconnection.

The migration backfills historical rows to v1 and intentionally installs no
database default. This is a hard-drain boundary: every new writer must persist
the version returned by encryption. After a row reaches v2, its required
versioned envelope also prevents an old image from silently replacing it with
v1 ciphertext under the retained v2 label.

1. Set `FINANCE_RUNTIME_MODE=locked`, pause integration on-demand workers, and
   retain the old 64-hex key in the incident/release vault.
2. With only the old key configured, run
   `pnpm tsx scripts/rotate-integration-encryption.ts --verify-only`. Any
   unknown version, malformed envelope, or decrypt failure blocks the release.
3. Replace `INTEGRATION_ENCRYPTION_KEY` with
   `INTEGRATION_ENCRYPTION_KEYS={"1":"<old-64-hex>","2":"<new-64-hex>"}`
   and set `INTEGRATION_ENCRYPTION_ACTIVE_VERSION=2`. Never configure the
   legacy and keyring variables together. The active version must always be the
   highest configured version; the runtime and rotator reject downgrade
   configurations.
4. Restart only the API and integration-capable on-demand lane. New OAuth and
   refresh writes now use v2 while both versions remain readable.
5. Run `pnpm tsx scripts/rotate-integration-encryption.ts`. The bounded scanner
   locks and rotates each row atomically, decrypts with the stored version and
   account/purpose context, and uses a CAS so a concurrent refresh/reconnect
   wins safely. A corrupt row is reported by safe account ID without preventing
   later rows from being attempted; any reported failure blocks completion.
6. Run `--verify-only` again and query the version distribution. Remove v1
   from the keyring only after the non-active row count is zero, canaries pass,
   and the prior key remains recoverable from the release vault.

The command never prints plaintext or ciphertext. Each failed row rolls back
completely and the command exits non-zero after reporting safe row IDs. Do not
rotate by direct SQL and do not delete an old key while any row still
references it. Historical `ERROR` accounts with the documented pair
of empty missing-credential sentinels carry no ciphertext/key dependency; the
verifier and rotator skip them, and only a fresh OAuth callback may repair them.

`packages/database/prisma.config.ts` uses `DIRECT_DATABASE_URL` for migration
commands and falls back to `DATABASE_URL` only for local development. In
production, provision two distinct database roles:

- the deploy role owns the application schema and runs reviewed migrations;
- the API/worker role receives only required table DML and sequence use.

The runtime role must not be a superuser, own application relations, inherit or
assume the deploy role, create in the application schema, create/alter/drop
objects, disable/replace triggers, or use `BYPASSRLS`. Never put
`DIRECT_DATABASE_URL` in a reusable service environment group. Run the
runtime-role authority query in
`docs/FINANCIAL_INCIDENT_QUERIES.md` through each API and worker connection
before reopening finance; any result is a release blocker.

### Deploy sequence (zero-surprise order)

The generic sequence below applies only when the release has no
mixed-version-incompatible financial guard. The payout-evidence and
payment-dispute/provider-inbox migrations require their dedicated hard-drain
procedures below: stop every old API and worker writer before migration, then
restore ingress only to the matching evidence-aware image.

Before either financial cutover, set `FINANCE_RUNTIME_MODE=recovery_only` on
the new image and rehearse this operation matrix:

| Lane | `normal` | `recovery_only` | `locked` |
|---|---:|---:|---:|
| Signed webhook/inbox persistence | allow | allow | allow |
| Exact provider polling and claimed-send/dispute recovery | allow | allow | block |
| Scheduled reconciliation/link checks | allow | allow | block |
| Read-only API and incident SQL | allow | allow | allow |
| Wallet spend, order capture/refund initiation | allow | block | block |
| Withdrawal request/approval/rejection | allow | block | block |
| New payout send or manual completion | allow | block | block |
| Settlement release and mutating deadline jobs | allow | block | block |

These rows map to the shared operation kinds exactly: `read` and
`inbound_evidence` are always allowed; `recovery` and `reconciliation` are
allowed only in `normal` and `recovery_only`; all other money mutations require
`normal`. Production treats missing or invalid configuration as `locked`.
Blocked API commands return `503 FINANCE_OPERATION_BLOCKED`. The signed
checkout-success and Stripe `account.updated` envelopes are persisted in
`locked`, but their requests still return 503 so Stripe retains the full
signed body for redelivery; “persistence allowed” does not promise a 2xx
acknowledgment when gated recovery work has not completed. An already
processed exact replay is a mutation-free 2xx no-op in every mode.

The mode does not protect against an old image that does not implement it.
Remove money-route access at the gateway, drain old writers, and prove their
replica count is zero before applying the guards.

The `20260802090000`–`20260803098000` boundary is also a hard-drain cutover.
Before applying it, stop API, finance workers, auto-accept/settlement workers,
and integration on-demand workers. The USD preflight must return no non-USD
fact; do not edit a failing row to USD. The migration then installs relational
settlement guards, quarantines Google old-writer paths, and adds persisted
integration key versions. Restart only the matching image in
`FINANCE_RUNTIME_MODE=recovery_only`; run migration assertions, reconciliation,
and sandbox canaries before deliberately returning finance to `normal`.
The final five migrations add append-only fraud-hold adjudication,
payload-bound order idempotency/contract snapshots, the one-active-revision
backstop, exact-evidence reconstruction for legacy withdrawal reservations,
and categorical pre-checkout deposit-failure evidence.
Legacy snapshot values stay `NULL` because current catalog terms are not
historical evidence. Old API and worker images do not understand those guards
and must remain drained. In particular, an old checkout writer can set a
deposit attempt to `FAILED` without its required `failureCode`; the database
rejects that legacy shape after `20260803098000`. Keep deposit ingress disabled
and every old API replica drained until the matching image is running. For this
release, migration status must report all 59 migrations current through
`20260803098000_deposit_provider_failure_evidence`.

Migration `20260802097000` is a narrow accounting-evidence repair, not a
general balance backfill. A missing legacy `PENDING` reservation qualifies
only when one exact pre-cutover request debit and matching requester audit
exist, there is no decision, reversal, execution, or existing allocation, and
every amount/currency/timestamp fact agrees. A legacy `REJECTED` reservation
qualifies only when that same pre-cutover debit is paired with one exact
post-cutover rejection reversal and matching request/rejection actor audits,
with no approval or payout execution. Any missing, duplicate, contradictory,
or otherwise ambiguous history aborts the migration.

For a proven pending reservation, the migration adds the amount to both
`allocationCarryForward` and `allocationCarryForwardUsed`, leaving available
carry-forward and `withdrawableBalance` unchanged. For a proven post-cutover
rejection, it adds the amount only to `allocationCarryForward` because the
exact reversal already restored the liability; the released allocation does
not consume carry-forward. The migration never changes pending/approved/debt,
lifetime earnings, or lifetime paid. Preserve a failed preflight and reconcile
the immutable ledger/audit history. Never improvise direct SQL, invent an
allocation, or adjust a balance merely to make the release proceed.

Before this boundary, run `pnpm test:migrations:finance` against the maintained
populated historical fixture and against a sanitized production clone. Also run
the paid-order/settlement queries in `docs/FINANCIAL_INCIDENT_QUERIES.md` and
require: one exact USD `PURCHASE` for every paid Order; one
`PlatformSettings` row; every active Settlement split matching the current
versioned fee policy; every Settlement publisher matching
`Order.websiteId -> Website.publisherId`; every unresolved fraud flag having
one exact current hold, every resolved flag having no hold, and every
resolution bound to its immutable flag;
positive cent-exact ListingService/Order/OrderItem amounts and exact captured
Order item count, total, status, website identity, and canonical
ListingService -> MarketplaceListing -> Website attribution; captured and
refunded Orders have exactly one matching PURCHASE, and no unpaid/failed Order
retains PURCHASE evidence;
automated release has newest successful active-delivery evidence within the
fixed 12-hour window, with `freshnessBlocked` alerted across two sweeps;
every unreversed PlatformRevenue row matching its exact PLATFORM
Order/PURCHASE and carrying a whole-cent versioned fee split; and no non-USD
financial fact. Never synthesize a `PURCHASE`, change a Website publisher, or
edit a fee split merely to pass preflight—preserve the rows and reconcile the
underlying money and attribution evidence. Reversed legacy PlatformRevenue may
remain explicitly unversioned; do not label it with the current policy unless
its original policy is independently proven.

1. `git pull` the release tag; `pnpm install --frozen-lockfile`.
2. **Backup first**: `scripts/backup-db.sh /var/backups/guestpost` (verifies dump readability).
3. Migrations: run `cd packages/database && npx prisma migrate deploy` in the
   isolated deploy job with `DIRECT_DATABASE_URL`; additive migrations only,
   and destructive changes need a two-release expand/contract. Destroy the
   job/credential injection after it exits and prove API/worker still connect
   only as the restricted runtime role.
4. `pnpm build` (11 targets; abort on any failure).
5. Follow the hybrid cutover in `docs/WORKER_ARCHITECTURE.md`: deploy the API,
   stop all old worker versions, start the realtime lane, then enable jobs.
6. Verify: `/api/v1/health` 200; realtime worker log shows four queues;
   manually run payout reconciliation and `GET /admin/reconciliation`.
7. Watch the reconciliation sweep for one cycle before calling it done.

Container path: `docker build -f apps/api/Dockerfile .` / `apps/worker/Dockerfile` from repo root; same env contract; compose healthcheck hits `/api/v1/health`.

### Required cutover for the payout-evidence migration

The payout-evidence migration is additive in shape but intentionally
fail-closed in behavior: after it lands, an old process cannot create a
provenance-less withdrawal/execution, replace command identity, reopen a failed
withdrawal, release allocations, cancel, or complete without canonical
evidence. Do not deploy it while an old API or worker can still write payout
state.

1. Build and validate the release image before the maintenance window.
2. Before merging or promoting this release, pause auto-deploy for every
   Blueprint-managed Render service and every Northflank worker/service
   auto-rollout. A merge-triggered rolling deploy is unsafe because the old and
   evidence-aware writers are not schema-compatible. Record the paused state
   and intended release image.
3. Set `FINANCE_RUNTIME_MODE=recovery_only` and
   `PAYOUT_EXECUTION_ENABLED=false` on the new release. Because the
   previously deployed code does not know this switch, also remove Finance
   execute access at the gateway/role boundary and verify no execute request is
   in flight.
4. Drain and stop **all** old API and worker instances. Provider webhooks may
   retry during this short window; do not disable or rotate webhook secrets.
5. While the old API is stopped, update the Stripe platform-transfer and
   connected-account Dashboard destinations to the explicit `/platform` and
   `/connected` URLs documented in `STRIPE_STAGING_RUNBOOK.md`. The retired
   shared Stripe payout route returns 400 without writing an inbox row. Keep
   both destinations enabled so any non-2xx delivery is retried.
6. Take the backup and run the migration preflight/deploy. The preflight is the
   first executable migration step and the preflight, DDL, and backfill share
   one explicit transaction. If it reports duplicate active/completed
   executions, reused evidence, or mismatched actor/timestamp provenance, keep
   sends frozen, preserve the rows, and reconcile them against provider/bank
   truth. Never choose or delete a row just to make the migration pass. The
   migration creates append-only `PayoutExecutionClaim` rows as the sole send
   authority, removes legacy `providerMetadata.externalClaims`, and classifies
   ambiguous pre-reference historical executions as
   `LEGACY_PROVIDER_OUTCOME_UNKNOWN` instead of declaring that no provider call
   happened.
7. Start only the new API and worker image with
   `FINANCE_RUNTIME_MODE=recovery_only` and
   `PAYOUT_EXECUTION_ENABLED=false`. Confirm migration status, health, one
   code version, one signed delivery plus exact redelivery on each new Stripe
   payout route, durable webhook processing, and payout reconciliation. A
   platform signature on the connected route and a connected signature on the
   platform route must both fail without an inbox write.
   Confirm old replicas are at zero before restoring ingress: the new triggers
   intentionally reject their insert/retry/cancel shapes, so a mixed fleet is
   an outage even though it remains money-safe.
8. Run the payout/dispute incident queries in
   `docs/FINANCIAL_INCIDENT_QUERIES.md`. Legacy withdrawals whose
   requester, approver, or execution-initiator provenance could not be
   recovered stay blocked pending a reviewed, evidence-backed provenance
   repair. Manual completion requires a known requester, approver, and
   execution initiator, plus a current Finance/Super Admin checker who is
   different from each of them. Historical failed executions also stay
   reserved until typed provider failure/cancellation evidence proves money
   did not move.
9. Exercise a sandbox/canary payout through terminal provider evidence. Only
   then set `FINANCE_RUNTIME_MODE=normal` and
   `PAYOUT_EXECUTION_ENABLED=true` on the intended API instances and restore
   Finance execute access.

`PAYOUT_EXECUTION_ENABLED=false` stops only a new external-send claim. Do not
stop verified webhook ingestion, status recovery, polling, reconciliation, or
safe evidence-backed cancellation for already in-flight money. It also permits
bounded exact-key recovery of a pre-existing durable claimed send; that
recovery may only advance the matching normalized claim's `lastClaimedAt` and
cannot mint a new claim or idempotency identity. JSON metadata is never send
authority.

All automated completion sources must provide the persisted provider object,
positive provider amount in minor units, and normalized provider currency.
They must exactly match the immutable execution destination. Stripe Connect
also requires the exact connected-account snapshot and the bank Payout ID
(`po_...`), never the Transfer ID. Missing or mismatched facts fail closed; a
verified webhook is quarantined and alerts Finance/Super Admin.

### Required cutover for financial evidence guards

The finance migrations install database triggers that reject legacy dispute
writers, protect payout evidence and state transitions, make provider inbox
envelopes append-only, and retire customer-wallet cash-out writes. A
mixed-version deployment is unsupported.

1. Set `STRIPE_DEPOSITS_ENABLED=false` to stop new Checkout sessions while
   leaving the signed webhook endpoint and Stripe credentials available. Set
   `FINANCE_RUNTIME_MODE=recovery_only`.
2. Drain and stop every old API and worker instance. Do not acknowledge
   dispute or checkout-success redeliveries with the old code during cutover.
3. Back up the database, then run one `prisma migrate deploy`. Prisma must apply
   the finance migrations in this canonical order:
   - `20260729085000_payment_provider_event_quarantine` (the separate enum
     commit boundary);
   - `20260729090000_payment_dispute_cases`;
   - `20260729095000_payout_webhook_event_quarantine` (the separate payout
     inbox enum commit boundary);
   - `20260729100000_payout_completion_evidence`;
   - `20260729110000_retire_customer_wallet_cash_out`;
   - `20260729120000_provision_finance_aggregates` (backfills only
     history-free missing publisher balances and organization wallets; aborts
     if financial history exists without its publisher or organization
     aggregate).
   Do not cherry-pick, reorder, or manually mark any of them applied.
4. Start only the new API and worker image. Confirm the five-minute
   `payment-dispute-inbox` maintenance task is registered and the hourly
   reconciliation sweep is healthy.
5. Redeliver sandbox checkout/dispute events. Run
   `docs/FINANCIAL_INCIDENT_QUERIES.md` and require zero unexplained inbox,
   case, ledger, or deposit-status findings before re-enabling new deposits.

### Required populated-data migration rehearsal

Clean-database migration replay proves installation order, not historical-data
behavior. Before applying these migrations to a shared environment:

1. Restore a sanitized recent backup into an isolated database.
2. Record migration checksums and confirm whether any candidate migration is
   already present in `_prisma_migrations`. Never edit an applied migration.
3. Run `prisma migrate deploy` while recording duration, blocked locks,
   before/after row counts, backfill classifications, trigger inventory, and
   `pg_constraint.convalidated`.
   The atomic dispute, payout, and deposit-failure-evidence migrations set a
   5-second `lock_timeout` and 15-minute `statement_timeout`. The payout
   migration takes a stable SHARE lock barrier across every
   provenance/preflight table before its first snapshot. The
   aggregate-provisioning migration uses the same lock timeout,
   a 120-second statement timeout, and a stable SHARE lock barrier across every
   parent, aggregate, and history table it reads. These barriers prevent an old
   writer from racing either corruption preflight. Any timeout rolls back the
   entire migration. Treat it as proof that an old writer or unexpected
   workload was not drained: keep finance sends and deposit ingress disabled,
   stop/drain the blocker, verify no partial migration was recorded, and retry
   the unchanged migration. Never increase the lock timeout merely to deploy
   through an active old writer.
4. Run every query in `docs/FINANCIAL_INCIDENT_QUERIES.md`; unexplained rows
   block deployment.
5. Exercise the `recovery_only` gateway/worker matrix and a forward-fix drill.
   An old application image is not a rollback target after the guards land.

After these guards contain financial evidence, an old application is not a
valid rollback target. Keep new deposits disabled and forward-fix; do not drop
triggers or rewrite evidence to make an old image run.

The rehearsal and production verification must both run the
`Unvalidated financial constraints` query in
`docs/FINANCIAL_INCIDENT_QUERIES.md` and return zero rows. A constraint present
with `convalidated = false` is not a passed release gate. Also compare
before/after counts for `PayoutExecutionClaim`, `PaymentProviderEvent`,
`PaymentDispute`, paid Orders, `PURCHASE` rows, Settlements,
`PlatformSettings` versions, `PlatformRevenue`, `OrderDeliveryVersion`,
`DeliveryVerificationEvidence`, `DeliverySnapshot`, `DeliveryFraudFlag`,
`DeliveryFraudHold`, `DeliveryFraudFlagResolution`, `Revision`,
withdrawals, executions, allocations, and money ledger rows; explain every
migration classification rather than treating matching totals as provider
truth.

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

1. Application rollback is permitted only when no newly installed financial
   guard rejects the target image's write shapes. Otherwise freeze new money
   commands and forward-fix with the evidence-aware release.
2. Migration rollback: **never roll back a migration with financial data written under it.** Roll the application back only — schema stays. All recent migrations are additive.
3. After any rollback run reconciliation; investigate any drift before reopening traffic.

Exception for the payout-evidence and payment-dispute/provider-inbox cutovers:
the pre-migration application is not a valid rollback target after their
triggers are installed. Its terminal, cancellation, dispute, and provider-inbox
writes lack the required evidence shape. Keep new payout sends and deposits
disabled, continue verified inbound evidence/reconciliation, and forward-fix or
redeploy the evidence-aware release. Do not drop constraints, rewrite inbox
rows, or erase provenance to make an old image run.

## 3. Database restore

Follow `docs/OPERATIONS.md` restore drill. Additional money-platform steps:
- Quantify the gap: compare latest `Transaction.createdAt` in the restored DB to the incident time; every later provider event must be replayed or manually reconciled.
- Stripe events: redeliver from Stripe dashboard. Deposit replay safety uses
  its provider payment identity; dispute replay safety uses the durable
  `(provider, providerDisputeId)` case identity. A generic uniqueness error is
  not evidence that an event was processed correctly.
- Wise: automated sends and claimed-send replay remain disabled. For any
  historical/manual Wise evidence, compare provider transfers with
  `PayoutExecution` for the gap window and perform incident-reviewed
  reconciliation; never invoke a new send or blind recovery replay.
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
2. Set `PAYOUT_EXECUTION_ENABLED=false`, disable the staff payout-execute
   endpoint/Finance role, and pause payout jobs. Stopping workers alone does
   not halt API-initiated transfers. On versions predating the global switch,
   the gateway/permission block is mandatory.
3. Disable new Stripe sends with `STRIPE_DEPOSITS_ENABLED=false` and/or
   `STRIPE_CONNECT_ENABLED=false`. **Do not** unset keys/secrets or disable the
   webhook endpoints: disputes, terminal events, and reconciliation for money
   already in flight must continue.
4. Snapshot: `scripts/backup-db.sh` immediately (evidence + recovery point).
5. Record the deployed Git SHA/image, migration status, feature flags, provider
   account/mode, and the last successfully reconciled time.
6. Trace with aggregate state, ledger, audit, and provider evidence. A ledger
   reference proves an internal row exists; it does not prove external
   settlement.

### Provider outage
- **Stripe down**: deposits fail at checkout (user-visible, no money risk). Disputes/webhooks queue on Stripe side and redeliver — idempotent handlers absorb the burst.
- **Wise down or Wise claim present**: Wise automated execution remains
  disabled. Keep the withdrawal reservation and execution evidence intact.
  Reconcile the original customer-transaction identity directly in Wise; do
  not turn an ambiguous result into `FAILED`, restore the balance, or issue
  another transfer.
- **Stripe Connect payout failure after Transfer**: the withdrawal remains
  reserved in `BANK_PAYOUT_RECOVERY_REQUIRED`. Finance must establish provider
  truth, then cancel the Payout/reverse the Transfer before re-execution or any
  balance restoration. See `docs/STRIPE_STAGING_RUNBOOK.md`.
- **Stripe send claim without a response**: wait until the 15-minute claim
  lease expires, then use Finance **Recover claim**. The API revalidates the
  locked route and repeats the exact original idempotency key even while new
  sends are disabled. Never repeatedly click recovery: each attempt renews the
  lease. At 23 hours the claim changes to `*_CLAIM_EXPIRED`, disappears from
  blind retry actions, alerts Finance/Super Admin, and requires Stripe object
  lookup plus an incident record.
- **`PAYOUT_PROVIDER_RESPONSE_QUARANTINED` alert**: keep payout execution and
  withdrawal liability reserved. The returned Stripe object failed immutable
  account/reference/amount/currency validation, so none of its IDs or metadata
  are canonical evidence. Run the read-only query in
  `docs/FINANCIAL_INCIDENT_QUERIES.md`, retrieve provider truth using the
  immutable connected-account scope and original idempotency key, and require
  Finance/Security adjudication. Do not paste provider values into the
  execution, complete/cancel it, restore balance, or start a replacement send.
- **Execution stranded before its first claim**: for `CREATED` or
  `DESTINATION_VALIDATED`, Finance may use Cancel. The API locks Withdrawal
  then PayoutExecution, proves there is no provider ID and no
  `PayoutExecutionClaim` row, records typed `PRE_PROVIDER_ABORT`, and atomically
  returns the still-reserved withdrawal to `APPROVED`. This is proof that no
  external call started, not provider cancellation. `providerMetadata` and
  audit JSON are informational and cannot establish this boundary. Never use
  this path after a send claim; after that boundary require typed provider
  cancellation/reversal evidence.
- **Late Stripe failure after local completion**: keep the completion and
  `lifetimePaid` immutable. Quarantine and alert on the signed event, establish
  bank/provider truth under an incident, and use only a separately designed
  compensating workflow. Bounded revalidation of recent completed payouts is a
  tracked MTTR improvement, not authority to auto-reopen.
- **Queue Redis down**: realtime/on-demand BullMQ work pauses. Payout webhooks
  still commit to the Postgres inbox and return 2xx; payout reconciliation
  catches up after Redis/job recovery. Other queued API work fails at enqueue.
- **Postgres down**: everything fails closed. Restore service, then run reconciliation before reopening.

### Chargeback handling

Automatic processing claims one durable dispute case, validates amount and
currency, applies the case-owned hold, records structured shortfall, and
resolves the case once to won/released or lost/debited. Case, wallet, ledger,
audit, and inbox outcome must commit together.

For failed, unlinked, contradictory, incomplete, or evidence-mismatch events:

1. leave the inbox event retryable/quarantined;
2. retrieve canonical Stripe dispute, PaymentIntent, charge, amount, currency,
   and status;
3. compare them with the deposit and dispute case;
4. keep the affected money path closed: this release has no generic repair
   command, so design, review, implement, and test an incident-specific typed
   idempotent compensation from provider truth;
5. rerun dispute and wallet reconciliation before clearing the incident.

A complete verified close-before-open event may create a terminal case
directly; verify that it booked the lost exposure or zero-movement won outcome
exactly once.

The `payment-dispute-inbox` task runs every five minutes. It recovers dispute
claims stale after 15 minutes, retries transient failures with 30-second to
10-minute exponential backoff, and quarantines deterministic contradictions
or events that exceed 432 attempts/72 hours. Tune only the batch size with
`PAYMENT_DISPUTE_INBOX_BATCH_SIZE`; changing lease or exhaustion policy
requires Finance/Security review.

Every claim is owned by its exact `(attempts, lockedAt)` pair. Recovery changes
both the effective attempt and timestamp; logs stating that an event was
failed, retried, or quarantined are valid only when the conditional write for
that same pair affected one row. A stale process that reports a lease change
made no mutation. Do not manually copy a timestamp, decrement `attempts`, mark
a live lease terminal, or treat a `PROCESSING` redelivery as a successful
replay. Inspect the current pair with the incident query below and let the
bounded recovery path claim it.

Checkout-success inbox rows are different: their persisted normalized envelope
does not contain enough provider data to mint a credit. A delivery in `locked`
persists `PENDING` evidence and returns 503; a redelivery that sees a fresh
`PROCESSING` lease also returns 503. All other non-terminal inbox replays
follow the same non-2xx ownership rule. These responses preserve Stripe
redelivery. The hourly reconciliation sweep pages on
`DEPOSIT_INBOX_STALE`, `DEPOSIT_INBOX_FAILED`, and
`DEPOSIT_INBOX_QUARANTINED`. The current release has no independent
authenticated Checkout/PaymentIntent catch-up processor: recover only from a
fresh signature-verified Stripe redelivery, never from local status, redirect
state, or an operator assertion.

The same signed-body rule applies to checkout expiry/failure and Radar
early-fraud-warning events: locked mode stores `PENDING` evidence and returns
503; redeliver after entering `recovery_only` or `normal`. Only normalized
dispute events may be acknowledged as deferred for worker replay. Unsupported
event types require no later money action and are atomically marked `IGNORED`
even while locked.

Track chargeback rate and provider evidence deadlines separately from internal
case correctness.

### Financial incident (drift confirmed)
1. Identify scope from reconciliation deltas (wallet vs publisher vs lifetimePaid).
2. Compare database state with canonical provider transactions/events; internal
   agreement alone does not prove external correctness.
3. Preserve a database backup and provider export before mutation.
4. Keep the affected path closed. This release ships no generic financial
   repair command. Design, review, implement, and test a reason-required,
   incident-linked, typed idempotent compensation for the specific evidence.
   It must atomically write the aggregate, balance, ledger, audit, and any
   mandatory durable notification record. Do not run direct balance SQL
   updates.
5. Re-run internal and provider reconciliation to prove zero unexplained drift;
   retain before/after evidence and complete a post-mortem.

## 5. Clean-environment bring-up checklist
1. Postgres + Redis up (compose healthchecks green).
2. `npx prisma migrate deploy` (creates full schema incl. CHECK constraints/partial indexes from the squashed baseline).
3. Never run `pnpm seed` outside a local development/test stack; it is
   fail-closed to local targets because it creates known-password identities
   and synthetic wallet money. Staging and production start without those
   fixtures. Provision the first SUPER_ADMIN through the separately reviewed
   database bootstrap into `StaffMembership` (no self-promote API exists by
   design).
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
