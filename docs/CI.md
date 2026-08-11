# CI/CD

## GitHub Actions gate

`.github/workflows/ci.yml` is the single required CI workflow. It runs for
pull requests targeting `main`, pushes to `main`, and manual dispatches.
Every Blueprint-managed Render service uses `autoDeployTrigger: off`. A green
workflow proves the reviewed commit passed the repository gate; it does not
authorize or start a deployment. Operators promote one exact commit manually
only after its migration, runtime-role, configuration, drain, and staging
canaries are complete.

The `CI / build-and-test` check performs:

1. Pull-request dependency review, rejecting newly introduced high or critical
   vulnerabilities
2. Frozen pnpm installation, compatibility-cohort validation, and a
   moderate-or-higher production dependency audit
3. Prisma migration deployment and status validation against PostgreSQL 17
4. A deterministic populated historical-fixture finance migration rehearsal
5. Integration-test template database creation and migration
6. TypeScript, Biome, ESLint, and dependency-graph validation
7. API unit and database-backed integration tests
8. Shared package and UI coverage tests
9. A complete production build of every workspace target

The workflow has read-only repository permissions, does not persist checkout
credentials, does not expose deployment secrets, pins third-party Actions and
service images, cancels superseded runs, and has a 60-minute timeout.

`pnpm deps:policy` reads `.github/dependency-policy.json`. It rejects mixed
direct Sentry/TypeScript/PostCSS versions, multiple resolved ioredis or Smithy
type versions, advisory-version regressions, and dependency declarations that
are silently replaced by an incompatible pnpm workspace override.

## Financial-change evidence

For a changed money path, CI must exercise the canonical invariants with real
PostgreSQL, not only mocked Prisma calls. The affected suite must cover allowed
and denied state edges, exact-version conflicts, duplicate commands, unique
collisions after rollback, lock contention, transaction rollback,
maker-checker denial, and evidence mismatch. Payout changes must additionally
prove normalized `PayoutExecutionClaim` authority and reject
`providerMetadata.externalClaims`; deposit changes must cover every
wallet-credit-backed derivative status and immutable Stripe `livemode`
evidence.

CI tests both a clean, fully migrated template and a deterministic populated
historical fixture. Together they prove clean installation and the known legacy
classifications encoded in the fixture. They cannot represent the full
production data distribution, certify production-scale lock duration, or
discover an unmodeled legacy payout/provider evidence shape. Before releasing a
financial-evidence migration, operators must also:

1. run `prisma migrate deploy` against a sanitized recent populated clone;
2. record before/after financial row counts, backfill classifications,
   migration duration, blocked locks, and trigger inventory;
3. require zero unvalidated financial constraints from
   `pg_constraint.convalidated`;
4. run every query in `docs/FINANCIAL_INCIDENT_QUERIES.md` and explain every
   result;
5. complete the relevant signed provider-sandbox matrix.

These operator artifacts are release evidence, not a reason to put production
credentials or provider payloads in GitHub Actions. A clean CI check never
overrides a failed populated-clone, staging, reconciliation, or provider-truth
gate.

## Deployment boundary

GitHub Actions validates code but does not hold staging or production
credentials and does not deploy directly. Render auto-deploy is disabled for
all Blueprint services. A schema-changing release requires an explicitly
coordinated manual promotion after `prisma migrate deploy` has completed
against the intended Neon database and every release-specific operational gate
has passed. Move migration deployment into a reviewed Render pre-deploy step
when the paid plan is enabled, but keep schema-before-code ordering explicit.

## Local verification

Run the code-quality gate locally with:

```bash
pnpm check
```

Before pushing a release-sensitive change, also run the affected tests and
builds. The GitHub workflow remains authoritative because it provisions clean
PostgreSQL and Redis services and runs the complete suite.
