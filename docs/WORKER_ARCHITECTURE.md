# Worker architecture and Northflank operations

## Purpose

The production worker uses a hybrid runtime. Only user-facing work that should
start promptly has a continuously running consumer. Periodic automation runs
through a short-lived Northflank dispatcher job, and bursty work starts a
short-lived job on demand. This
preserves BullMQ durability while avoiding an idle Redis poller for every
logical queue.

`WORKER_MODE=all` remains available for local development and emergency
rollback. It is not the recommended production shape.

## Runtime lanes

| Lane | `WORKER_MODE` | Lifetime | Work |
|---|---|---|---|
| Realtime | `realtime` | Continuous, one replica | Email, in-app notifications, requested website DNS verification, requested delivery/link verification |
| On demand | `on-demand` | Starts on API wake-up, drains, exits | Reports, generic verification, publisher trust recomputation, integration discovery/sync, legacy payout queue drain, payout webhook inbox |
| Scheduled | `scheduled` | Due maintenance tasks, then exits | Payout reconciliation, financial reconciliation, settlement automation, order deadlines/reminders, link monitoring, website re-verification |
| Compatibility | `all` | Continuous | All legacy workers and BullMQ repeatable schedules |

The realtime lane deliberately excludes payout. The API sends a payout to the
provider synchronously under a finance-authorized endpoint. Worker-side payout
code only reconciles provider truth; it never initiates a transfer.

## Payout safety model

### Initiation

1. Finance calls the staff-only execute endpoint.
2. The API moves the approved withdrawal to `PROCESSING` with version guards,
   creates `PayoutExecution`, and assigns a deterministic provider idempotency
   key.
3. Wise receives a deterministic `customerTransactionId`; Stripe receives the
   `Idempotency-Key` header.
4. The provider call happens in the API. There is no `payout-execute` worker
   job, and one must not be reintroduced without a separate financial design.

If an error occurs after the provider request and no provider transfer ID was
recorded, retry now fails closed. Finance must reconcile the original
`PayoutExecution.idempotencyKey` in the provider dashboard before taking an
action. Creating a new idempotency key while the first outcome is unknown can
double-pay the publisher.

### Webhook receipt

`POST /payout-webhooks/:provider` performs this sequence:

1. Reject unsupported providers.
2. Verify the Stripe HMAC or Wise RSA signature against the raw body.
3. Enforce the five-minute replay timestamp window.
4. Parse and normalize the provider payload.
5. Persist an allow-listed `PayoutWebhookEvent` row.
6. Return success only after the Postgres commit.
7. Send a best-effort Northflank wake-up with no payout/customer identifiers.

Raw provider payloads, signature headers, bank details, and provider error
bodies are not stored in the inbox. Event deduplication is permanent and uses
the provider event ID hash, or a verified raw-payload hash when no event ID is
available. It never deduplicates solely by transfer ID because one transfer can
emit `processing`, `failed`, and `completed` events.

The inbox processor claims rows with conditional updates. Stale claims recover
after 15 minutes. A webhook that arrives before the API saves
`providerExecutionId` remains retryable for up to 72 hours instead of being
discarded. The 432-attempt ceiling is a secondary corruption/clock guard and
does not shorten that age window under the capped ten-minute backoff.
Completion is version-guarded and locks `PublisherBalance` before incrementing
`lifetimePaid`. A provider-completed transfer whose local execution is in an
unsafe state is not mutated silently; it creates a
`PAYOUT_WEBHOOK_STATE_CONFLICT` audit event for Finance review.

### Scheduled reconciliation

The five-minute maintenance dispatcher invokes `payout-reconcile` every ten
minutes. A direct `WORKER_TASK=payout-reconcile` run remains available for
incident recovery and processes up to
`PAYOUT_WEBHOOK_INBOX_BATCH_SIZE` ready inbox events and polls up to
`PAYOUT_STATUS_BATCH_SIZE` provider transfers that remain `PROCESSING`. Run it
every 10 minutes; successive runs bound larger backlogs. Webhooks are the
prompt signal, and polling is the independent recovery path.

## Scheduled task catalog

The task catalog remains individually runnable with `WORKER_MODE=scheduled`
and one `WORKER_TASK`:

| `WORKER_TASK` | Recommended cron (UTC) | Notes |
|---|---:|---|
| `payout-reconcile` | `*/10 * * * *` | Inbox + provider status safety net |
| `settlement-auto-approve` | `*/15 * * * *` | Review-window approvals |
| `settlement-auto-release` | `5,20,35,50 * * * *` | Offset from approval |
| `cancellation-timeouts` | `*/15 * * * *` | Cancellation response deadlines |
| `acceptance-timeouts` | `10,25,40,55 * * * *` | Order acceptance deadlines; at most three minutes later than the legacy cadence |
| `auto-accept` | `10 * * * *` | Orders past review window |
| `review-reminders` | `20 * * * *` | Upcoming review deadline email |
| `reconciliation` | `30 * * * *` | Financial drift detection |
| `settlement-link-check` | `0 */6 * * *` | Verify links while funds are held |
| `website-reverify` | `0 3 1 * *` | Monthly ownership re-verification |

On a paid project, these may be separate jobs. The current Northflank free
project is limited to two jobs, so use one job with
`WORKER_TASK=maintenance-dispatch` on `*/5 * * * *`. It deterministically runs
only the catalog tasks due in that UTC slot. Set its concurrency policy to
**forbid** and its timeout to 30 minutes. The dispatcher attempts every due
task even if an earlier one fails, then exits non-zero with an aggregate error.
Successful tasks retain their BullMQ idempotency marker, so a platform retry
cannot duplicate them.

`SETTLEMENT_AUTO_APPROVE_DISABLED` and
`SETTLEMENT_AUTO_RELEASE_DISABLED` are honored by both the compatibility
scheduler and the maintenance dispatcher.

## Northflank production layout

Build one image from `apps/worker/Dockerfile` and reuse the identical immutable
tag for all lanes.

### 1. Realtime service

- Command: `node apps/worker/dist/index.js`
- Environment: `WORKER_MODE=realtime`
- Replicas: exactly 1 initially
- Health: `GET :3004/health`
- Readiness: `GET :3004/ready`
- Resources: start at 0.2 shared vCPU / 512 MB and tune from metrics

Realtime startup removes legacy BullMQ repeatable definitions before starting
its four consumers. Do not run it beside a stale `WORKER_MODE=all` process.

### 2. On-demand job

- Command: `node apps/worker/dist/index.js`
- Environment: `WORKER_MODE=on-demand`
- Concurrency policy: **forbid**
- Timeout: 10 minutes (match `WORKER_ON_DEMAND_MAX_RUNTIME_MS`)
- Schedule: `*/10 * * * *` for mandatory catch-up; API runs use the same job
- Restart policy: no continuous restart

Create a project-scoped Northflank API token with only
`Project > Jobs > General > Read`, the permission Northflank requires for its
official [run-job operation](https://northflank.com/docs/v1/api/project/jobs/run-job).
Do not grant secret, log, deployment-update, or broader project permissions. Store
`https://api.northflank.com/v1/projects/{projectId}/jobs/{jobId}/runs` in
`WORKER_ON_DEMAND_TRIGGER_URL` and the token in
`WORKER_ON_DEMAND_TRIGGER_TOKEN` on API services. The request sends the empty
Northflank runtime-overrides object (`{}`); no GuestPost identifiers are sent.
Production rejects any host/path other than the official Northflank run-job
endpoint, as well as non-HTTPS or credential-bearing URLs. Never put the token
in a URL, log, image, or client bundle.

The API wake signal is only an optimization. Queue/inbox persistence happens
first; the job's ten-minute schedule is the mandatory catch-up for missed or
throttled wake signals.

### 3. Scheduled maintenance dispatcher

Create one cron job using the same command and image with
`WORKER_MODE=scheduled`, `WORKER_TASK=maintenance-dispatch`, and
`*/5 * * * *`. This is the second and final job allowed by the free project.
Keep payout provider credentials on this dispatcher only when provider polling
is enabled; the realtime worker never receives payout initiation or payout
method decryption keys.

## Redis configuration and command budget

`QUEUE_REDIS_URL` is the BullMQ connection. It falls back to `REDIS_URL` for
local compatibility. In production, separate them so queue traffic and
retention cannot evict or interfere with auth rate limits, cache, and pub/sub.

BullMQ empty queues still issue Redis commands. The worker defaults are:

- `WORKER_DRAIN_DELAY_SECONDS=300`
- `WORKER_STALLED_INTERVAL_MS=300000`
- `QUEUE_METRICS_CACHE_MS=1800000` (30 minutes)

These defaults follow Upstash's low-command guidance. Job markers normally wake
the blocked consumer promptly; five minutes is the empty/recovery polling
ceiling. Queue metrics are cached because collecting all queue counts is itself
expensive; the realtime health server queries only its four queues. Do not
scrape both API and worker queue endpoints as independent monitoring sources.

Monitor actual commands for at least seven representative days. Free-tier
headroom is not guaranteed by configuration alone; real traffic, retries,
metrics, and queue cleanup also consume commands. Move to a fixed Redis plan
before production volume if command usage approaches 70% of quota.

## Environment contract

Required on all worker lanes:

- `DATABASE_URL`
- `QUEUE_REDIS_URL` or the compatibility `REDIS_URL`
- `QUEUE_SIGNING_SECRET` in production

Lane-specific:

- Realtime: SMTP and verification/object-storage settings used by its queues
- On demand: integration encryption/provider settings, report settings, payout
  provider settings for inbox recovery
- Scheduled dispatcher: the union of credentials needed by enabled maintenance
  tasks; never include payout method decryption keys
- API: `WORKER_ON_DEMAND_TRIGGER_URL` and
  `WORKER_ON_DEMAND_TRIGGER_TOKEN` for immediate burst processing

The integration worker package is loaded lazily only in `on-demand` and legacy
`all` modes. This is a security boundary, not just a startup optimization:
`realtime` and `scheduled` must boot without `INTEGRATION_ENCRYPTION_KEY` or
Google OAuth credentials. CI has a lane-boundary contract test to prevent a
future eager import from silently broadening those workloads' secret access.

Do not reuse database, Redis, queue-signing, webhook, encryption, or Northflank
trigger credentials. Put each in Northflank secret storage and rotate them
independently.

## Deployment and cutover

1. Back up Postgres.
2. Before migration, confirm no provider reference is duplicated:
   `SELECT "providerId", "providerExecutionId", count(*) FROM "PayoutExecution" WHERE "providerExecutionId" IS NOT NULL GROUP BY 1,2 HAVING count(*) > 1;`
   Stop and reconcile if this returns any row.
3. Deploy the additive `PayoutWebhookEvent` migration, which also enforces
   provider-scoped transfer-reference uniqueness.
4. Build and publish one immutable API/worker image set.
5. Create the two Northflank jobs with the new worker image: an on-demand drain
   with a ten-minute catch-up schedule and a five-minute maintenance dispatcher.
   Keep their schedules paused until cutover.
6. Deploy the new API. Verified payout events now accumulate durably even if no
   job is running yet.
7. Let the old worker drain `integration-sync` and `integration-discovery`, then
   verify both have zero waiting/active/delayed jobs. New producers sign these
   jobs; the new worker intentionally rejects any legacy unsigned payload.
8. Stop every old worker replica. Do not overlap worker code versions.
9. Start the realtime service with `WORKER_MODE=realtime`; confirm the log says
   four queues and legacy repeatables were removed.
10. Run the maintenance dispatcher in a payout-reconciliation slot, then run
    the on-demand job once.
11. Enable the five-minute maintenance schedule and the on-demand job's
    ten-minute catch-up schedule.
12. Verify health, queue depth, inbox state, Redis command rate, and financial
    reconciliation before declaring the cutover complete.

The safe emergency fallback is the same new image with `WORKER_MODE=all`. It
re-registers legacy repeatables. Do not remove the additive database migration
on rollback. Before rolling the application back to an older code version,
drain all pending payout inbox events with the new worker image.

## Monitoring and incident checks

- Realtime service: `/health`, `/ready`, and cached `/metrics/queues`
- Job runs: non-zero exit, duration, retry count, and concurrency conflicts
- Database: counts/oldest age for `PayoutWebhookEvent` in `PENDING`, `FAILED`,
  and stale `PROCESSING`
- Payouts: `PayoutExecution` in `PROCESSING` over two hours and unmatched inbox
  audit action `PAYOUT_WEBHOOK_UNMATCHED`
- Redis: daily command count, storage, failed jobs, and oldest waiting job
- Sentry: job failures, worker-level Redis errors, and reconciliation drift

If payout inbox age exceeds 10 minutes, run `payout-reconcile` manually. If an
execution has no provider transfer ID after an ambiguous send, freeze retry for
that withdrawal and reconcile the stored idempotency key with the provider.
Never create a replacement transfer based only on local `FAILED` state.
