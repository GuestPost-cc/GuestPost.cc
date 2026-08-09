---
note_type: domain-memory
domain: publisher-payouts
project: guestpost-platform
updated: 2026-08-03
---

# Publisher Payouts

`docs/FINANCIAL_INVARIANTS.md` is canonical when this summary is incomplete.

## Liability and withdrawal

`PublisherBalance` tracks pending, approved, withdrawable, debt, lifetime
earnings, and lifetime paid with optimistic versioning. A withdrawal request
subtracts withdrawable liability once and creates immutable
`WithdrawalAllocation` rows. Approval proves that reservation and eligibility;
it never checks the already-reserved amount against available balance again.

The effective withdrawal graph is
`PENDING -> APPROVED|REJECTED -> PROCESSING`, with
`PROCESSING -> APPROVED|FAILED|COMPLETED` and
`FAILED -> APPROVED|COMPLETED`. Reopening requires the latest execution to
carry typed cancellation. Completion requires exactly one evidence-backed
completed execution. Runtime reversal remains disabled.

Requester, decision actors, immutable command fields, allocations, status
edges, exact version increments, and terminal state are protected in
PostgreSQL. Approval/rejection require a current unbanned Finance/Super Admin.

Migration `20260802097000_legacy_withdrawal_reservation_evidence` reconstructs
only exact legacy reservation evidence. A missing pending allocation requires
one pre-cutover request debit and matching requester audit, with no decision,
reversal, execution, or allocation. A missing rejected allocation additionally
requires one exact post-cutover rejection reversal and matching actor audits,
with no approval or execution. Ambiguous history aborts instead of being
guessed. Pending reconstruction adds equal carry-forward and used amounts;
rejected reconstruction adds only carry-forward because its proven reversal
already restored liability. Neither changes withdrawable balance or lifetime
paid, and direct SQL is never an accepted fallback.

## Provider execution and send authority

`PayoutExecution` records the immutable route command, destination/provider
snapshots, provider references, execution stage, completion/cancellation
evidence, and actor provenance. Stripe Connect persists separate Transfer and
connected-account bank-Payout IDs; only paid bank-Payout evidence with exact
amount, currency, and account scope may complete.

`PayoutExecutionClaim` is the sole send authority. One append-only
`PROVIDER_SEND` and one `BANK_PAYOUT_SEND` claim may exist per execution. Each
stores the exact idempotency key, SHA-256 fingerprint, first claimant/time, and
monotonic replay lease time. Claim and claimed stage commit atomically.
`providerMetadata` is informational; `externalClaims` is forbidden.

Every new external-send claim repeats the shared payout-method runtime
eligibility predicate while the Withdrawal, execution, balance, provider,
provider-account, and payout-method routing rows remain locked. A Finance-mode
pause, Stripe Connect disablement, or manual-bank rollout change between
initial validation and provider I/O therefore prevents the claim. Recovery of
an already durable aged claim remains narrowly available with only its exact
original idempotency identity and immutable route; configuration changes never
authorize a new claim.

Claims lease for 15 minutes. From 15 minutes through 23 hours, exact-key
recovery may advance only `lastClaimedAt` after locked revalidation. At 23
hours the claim becomes review-only; provider lookup and Finance adjudication
replace blind replay. A locked no-send check may abort only
`CREATED`/`DESTINATION_VALIDATED` with no provider ID and no normalized claim.

Legacy direct payout-method entry is disabled outside an explicit rollout.
When enabled, each rail has a bounded allowlisted schema; unknown or
cross-rail secret fields are rejected. Current publisher-owner membership,
user eligibility, and publisher identity are locked and revalidated inside the
same serializable transaction as encryption, default-method serialization,
creation, and audit.

The certified method set for a new withdrawal is closed to manual
`bank_transfer` while its rollout is enabled and a fully ready
`stripe_connect` method bound to the same publisher's active USD provider
account. PayPal and Wise rows are legacy lifecycle records: they remain
readable for support and can be disabled, but cannot be created, reactivated,
selected, or used for a new reservation. Exact replay of a historically
committed idempotent request remains read-only. Method and provider query
failures, runtime pauses, invalid provider bindings/readiness, positive debt,
and missing destinations fail closed in the publisher UI; request and approval
transactions re-lock and revalidate the same shared eligibility predicate.

## Completion and maker-checker

Automated completion belongs to verified provider response, authenticated
status retrieval, or verified terminal webhook evidence for the persisted
provider object. Generic Mark Paid cannot create a synthetic manual execution
or complete an automated route.

The execution initiator and first provider-send claimant must be current
eligible staff and each differs from the approver. Manual bank completion is
limited to an existing sent manual execution and requires immutable payment
evidence plus a current Finance/Super Admin checker distinct from requester,
approver, and execution initiator. The operator sees publisher, amount,
currency, withdrawal reference, and execution identity, must type the exact
canonical withdrawal reference, and the finalizer compares it with the locked
Withdrawal row before any liability mutation. A missing or mismatched reference
is an audited conflict.

Historical `LEGACY_UNVERIFIED` completion/cancellation and
`LEGACY_PROVIDER_OUTCOME_UNKNOWN` stages are classifications, not proof.
Wise automated sends, completion, and claimed-send replay remain disabled
pending certification.

## Runtime and operations

`FINANCE_RUNTIME_MODE=normal` permits classified finance operations;
`recovery_only` permits reads, signed inbound evidence, recovery, and
reconciliation; `locked` permits only reads and inbound evidence. Missing or
invalid production configuration resolves to `locked`.
`PAYOUT_EXECUTION_ENABLED=false` blocks new send claims but not exact recovery
of an existing claim. Financial-guard migrations require a hard drain,
populated-clone rehearsal, validated constraints, signed sandbox evidence, and
forward-fix rollback. The payout and aggregate migrations take stable,
fail-fast SHARE lock barriers before their corruption preflights so old
READ-COMMITTED writers cannot race a successful snapshot.

The current release contains 59 migrations through
`20260803098000_deposit_provider_failure_evidence`; every writer remains
drained until that ordered chain and its exact-evidence postflights succeed.

## Key files

- `apps/api/src/modules/publisher-payouts/`
- `packages/database/prisma/schema.prisma`
- `packages/shared/src/payout-status.ts`
- `packages/shared/src/finance-runtime-mode.ts`
- `docs/PAYMENTS_ARCHITECTURE.md`
- `docs/FINANCIAL_INCIDENT_QUERIES.md`
