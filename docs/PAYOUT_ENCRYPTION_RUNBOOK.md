# Payout Encryption v2 Runbook

## Security boundary

`PayoutMethod.details` and every non-empty `PayoutProvider.config` use
AES-256-GCM with a random 12-byte IV and a 16-byte authentication tag. New
writes have the envelope `p2:<opaque-key-id>:<canonical-base64-payload>` and
store database format version `2`. The format number is not key identity.

Authenticated data prevents copying otherwise valid ciphertext between rows:

- payout method: format domain, method ID, publisher ID, and method type;
- payout provider: format domain, provider ID, and provider name.

The key provider is injected behind `PAYOUT_ENCRYPTION_KEY_PROVIDER`. Its
bounded contract exposes one active key ID and at most 15 additional
decrypt-only IDs. The checked-in environment adapter accepts at most 16
distinct 32-byte keys and copies key material at its boundary. A managed KMS
adapter must resolve or unwrap the same bounded set before injecting the
provider; crypto call sites do not depend on a cloud vendor or network.

## Configuration

Provision independent random keys. Never derive one key from another, encode a
secret in the key ID, or reuse the legacy key as a v2 key.

```dotenv
PAYOUT_ENCRYPTION_KEYS={"payout-2026-08":"<64-hex-active>","payout-2026-07":"<64-hex-decrypt-only>"}
PAYOUT_ENCRYPTION_ACTIVE_KEY_ID=payout-2026-08
PAYOUT_ENCRYPTION_KEY=<64-hex-legacy-v0-v1-read-key>
```

`PAYOUT_ENCRYPTION_KEYS` and `PAYOUT_ENCRYPTION_ACTIVE_KEY_ID` are required in
development, staging, and production. Missing, empty, malformed, duplicate,
oversized, or mismatched configuration fails application startup. There is no
development fallback. A deterministic provider exists only inside a Jest
worker with `NODE_ENV=test` and no payout key environment variable present.

Every keyring entry other than the active ID is decrypt-only. Retain it until a
full verifier reports no envelope using that ID. `PAYOUT_ENCRYPTION_KEY` is a
separate legacy read key for raw-base64 formats 0 and 1; v2 encryption never
uses it.

## One-time v1 to v2 cutover

This is a hard-drain release. Old application images cannot read v2 envelopes,
and the database guard rejects their legacy writes after migration. Do not use
a mixed rolling deployment.

1. Take and verify a restorable database backup. Preserve the legacy key in the
   approved secret vault.
2. Provision a new, distinct v2 keyring and active ID on every API and worker
   environment. Keep `PAYOUT_ENCRYPTION_KEY` for legacy reads.
3. Set `FINANCE_RUNTIME_MODE=locked` and `PAYOUT_EXECUTION_ENABLED=false`.
   Stop payout-capable API/worker images and drain or adjudicate all nonterminal
   payout executions. Rotation intentionally refuses to invalidate an
   execution's encrypted-destination/provider snapshot.
4. With the new release artifact and no writers, verify every row:

   ```bash
   pnpm payout-encryption:verify --batch-size 25
   pnpm payout-encryption:rotate --dry-run --batch-size 25
   ```

   Either command exiting non-zero blocks the release. Output contains only
   row IDs, versions/key IDs, counts, and normalized failure classes.
5. Apply migration
   `20260812101000_payout_encryption_v2_keyring`. Its preflight rejects corrupt
   historical data. It then allows untouched legacy rows only for rotation,
   requires v2 on every new payout method/non-empty provider config, and
   prevents version relabels, downgrades, and legacy ciphertext rewrites.
6. Deploy only the v2-capable API and worker images. Keep finance locked.
7. Rotate every active and inactive payout method and every non-empty provider
   config:

   ```bash
   pnpm payout-encryption:rotate --batch-size 25
   ```

   Each row is locked, authenticated using its persisted immutable context,
   re-encrypted with the active key, and compare-and-swapped with one aggregate
   version increment. A concurrent change wins; no partial row is committed.
8. Re-run both full verification paths:

   ```bash
   pnpm payout-encryption:rotate --verify-only --batch-size 25
   pnpm payout-encryption:verify --require-active --json
   ```

9. Run an audited payout-method create/decrypt canary and provider sandbox
   payout canary. Restore finance gates only after reconciliation and canaries
   pass.
10. Remove `PAYOUT_ENCRYPTION_KEY` only after `--require-active` passes, which
    proves zero v0/v1 rows and zero decrypt-only envelopes. Remove old v2 key
    IDs only while that gate remains green and the keys remain recoverable
    under the retention policy.

## Resume and failure handling

Both tools scan stable ascending IDs in bounded batches. A plain rerun is safe:
rows already on the active key authenticate and are skipped. For an explicitly
partitioned resume, use `--method-after-id <id>` and
`--provider-after-id <id>`. Do not resume after a failed row unless that row has
been repaired or the next run starts before it.

Never repair by changing only `encryptionKeyVersion`, editing an envelope key
ID, or direct SQL re-encryption. Those operations either fail database guards
or GCM authentication. Preserve the ciphertext, row identity, configured key
IDs, and safe error class for incident review; never put key material,
plaintext, or ciphertext in tickets or logs.

## Rotation after cutover

1. Add one new distinct key under a fresh opaque ID while retaining every old
   ID.
2. Restart with the new ID as `PAYOUT_ENCRYPTION_ACTIVE_KEY_ID`; new writes now
   use it immediately.
3. Keep payout execution drained, run `--dry-run`, rotate, then run both full
   verifiers, including `verify-encryption-versions.ts --require-active`.
4. Remove decrypt-only IDs only after their envelope count is zero, canaries
   and reconciliation pass, and the retention window is approved.

## Rollback and compromise

Before the database migration, rollback means stopping the new artifact and
restoring the prior configuration; no v2 write may have occurred. After the
migration or any v2 write, the old application is not a valid rollback target.
Keep the database and keys, remain finance-locked, and forward-fix the v2
artifact. Restoring the pre-cutover backup is the only full rollback and loses
all later writes, so it requires incident/change approval.

If a key may be compromised, retain it as decrypt-only only inside the
approved incident boundary, rotate all rows to a clean active key, verify the
entire dataset, then revoke the compromised key. If both database and key
material were exposed, rotation limits future access but cannot undo prior
disclosure; follow the data-breach response process.

## Managed KMS production gate

The repository supplies the provider contract and a bounded environment-backed
implementation so rotation can be rehearsed without network access. Paid
production still requires operations to provision a managed KMS/HSM policy,
least-privilege runtime identity, audited unwrap/decrypt access, availability
and startup behavior, break-glass ownership, retention, and recovery. Inject a
provider that preloads/unseals only the configured active plus decrypt-only
keys. Do not claim KMS protection while raw production keys remain ordinary
process environment secrets.
