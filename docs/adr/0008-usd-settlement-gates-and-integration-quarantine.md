# ADR 0008: USD boundary, canonical settlement gate, and Google-metric quarantine

- Status: Accepted
- Date: 2026-08-02
- Owners: Finance, Security, Marketplace, Integrations

## Context

Money amounts were not consistently paired with currency. A non-USD listing
could become a non-USD order, spend the numerically equivalent USD wallet
balance, and later create currencyless publisher liability. Automated
settlement paths also duplicated only fragments of the delivery-eligibility
rules, so a dispute, revision, cancellation, fraud flag, or changed delivery
could be missed at release time.

Google property access proved that a caller could read a resource, but did not
prove that the GSC property or GA4 web stream represented the marketplace
Website canonical domain. GA4 summaries could overwrite listing traffic used
for public filtering/ranking. Integration token encryption accepted malformed
key material and did not persist the master-key version needed for rotation.

## Decision

### One accounting currency at launch

The platform supports exact, case-sensitive `USD` only. Currency is part of an
amount's identity at every catalog, order, wallet, deposit, dispute,
settlement, revenue, withdrawal, execution, allocation, batch, and ledger
boundary. Application code rejects non-USD before mutation and writes ledger
currency explicitly. PostgreSQL `CHECK` constraints and cross-row triggers are
the final authority.

Migration preflight aborts on historical non-USD facts. It never relabels them;
Finance must reconcile their economic meaning before retrying the migration.
Future multi-currency work requires a new ADR with typed money values, FX-rate
evidence, per-currency balances, and reconciliation.

### One live settlement predicate

All create, approve, and release paths—manual and automated—call the canonical
eligibility evaluator inside the transaction. `Order` is the aggregate lock.
PostgreSQL blocker triggers serialize dispute, revision, fraud, cancellation,
and delivery-version writes through that row. A database settlement trigger
rechecks the relational predicate on insert/release. Settlement money/policy
snapshots are immutable, a partial unique index allows one release ledger row
per settlement, and deferred guards require that append-only row to match the
released settlement's exact order, publisher, amount, and currency at commit.

The finalizer uses exact status/version predicates. Any race after the first
write throws and rolls the transaction back; “skipped” is valid only before a
write. Policy decides review timing, never eligibility.

### Google metrics remain off until domain binding exists

Existing GSC/GA4 OAuth account records are retained for incident-safe recovery,
but new OAuth initiation and in-flight callbacks, discovery, linking, sync,
schedules, daily writes, summaries, and public projection are compile-time and
database quarantined with `GOOGLE_METRICS_DISABLED`. Existing raw daily data is
retained as untrusted history. Legacy summaries are scrubbed, and listing
traffic is re-derived only from normalized Ahrefs organic traffic.

Re-enable requires an append-only provider/resource/canonical-domain binding,
one active binding per website/provider, explicit GSC permission policy, and
GA4 web-stream `defaultUri` plus hostname/stream filtering. Website canonical
domain is immutable in the ordinary update path. It also requires every OAuth
connection/create/reactivation path to serialize on the same ExternalAccount
row as disconnect and re-check that credential's active status after acquiring
the lock. Disconnect preserves link ids as tombstones, disables the schedule in
the same transaction, and revokes the shared provider credential only when no
other non-disconnected integration uses it. Decryption or provider revocation
failure is fatal: the local aggregate remains connected and retryable rather
than claiming an unproven disconnect.

### Integration encryption supports hard rotation

A configured key is exactly 64 hexadecimal characters in every environment;
an explicitly configured empty value is invalid, and production has no
fallback. The rotation configuration is a bounded JSON version-to-key map plus
an explicit active version, which must be the highest configured version and at
least 2. Every ExternalAccount row stores the version used by both token
ciphertexts; decrypt requires that exact version. Version 2+ envelopes are
prefixed with that version and authenticated to the immutable account identity
and access/refresh purpose. OAuth and refresh writes rotate both fields
together, and refresh uses compare-and-swap to avoid overwriting a reconnect or
rekey winner.

The reviewed batch command refuses downgrade configuration, verifies/decrypts
with the stored version and identity/purpose context, and locks each row before
atomically replacing both fields. Old keys remain in the keyring until every
row is verified on the active version.

## Consequences

- Catalog imports/requests containing EUR, GBP, lowercase USD, or whitespace
  now fail rather than being accepted or normalized.
- The settlement database triggers are mixed-version incompatible with old
  writers. Deployment requires a hard drain, migration, new-image restart,
  and PostgreSQL concurrency canaries before finance returns to `normal`.
- Google site metrics temporarily disappear. This is preferable to publishing
  or ranking on data whose website identity is unproven.
- Key rotation needs both keys during the dual-read window and an explicit
  batch/verification step; deleting the old key early is a release blocker.

## Verification

- Unit tests cover currency mismatch with zero writes, each eligibility
  blocker, rollback on CAS loss, Google fail-closed boundaries, malformed keys,
  old-key read/new-key write, and refresh/rekey races.
- Real PostgreSQL tests cover USD checks/cross-row links, release-versus-blocker
  races, duplicate release prevention, Google old-writer rejection, migration
  scrubbing, and token-version guards.
- The populated migration rehearsal must pass, followed by sandbox deposit and
  payout canaries with explicit feature flags. Fail-closed flags are not a bug:
  local/staging money movement requires `FINANCE_RUNTIME_MODE=normal` plus the
  relevant Stripe/payout switch and test credentials.
