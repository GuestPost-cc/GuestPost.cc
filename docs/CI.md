# CI/CD

## GitHub Actions gate

`.github/workflows/ci.yml` is the single required CI workflow. It runs for
pull requests targeting `main`, pushes to `main`, and manual dispatches.
Render services retain `autoDeployTrigger: checksPass`, so a push is deployed
only after this workflow succeeds.

The `CI / build-and-test` check performs:

1. Pull-request dependency review, rejecting newly introduced high or critical
   vulnerabilities
2. Frozen pnpm installation, compatibility-cohort validation, and a
   moderate-or-higher production dependency audit
3. Prisma migration deployment and status validation against PostgreSQL 17
4. Integration-test template database creation and migration
5. TypeScript, Biome, ESLint, and dependency-graph validation
6. API unit and database-backed integration tests
7. Shared package and UI coverage tests
8. A complete production build of every workspace target

The workflow has read-only repository permissions, does not persist checkout
credentials, does not expose deployment secrets, pins third-party Actions and
service images, cancels superseded runs, and has a 60-minute timeout.

`pnpm deps:policy` reads `.github/dependency-policy.json`. It rejects mixed
direct Sentry/TypeScript/PostCSS versions, multiple resolved ioredis or Smithy
type versions, advisory-version regressions, and dependency declarations that
are silently replaced by an incompatible pnpm workspace override.

## Deployment boundary

GitHub Actions validates code but does not hold staging or production
credentials and does not deploy directly. Render watches `main` and deploys the
commit after GitHub checks pass. While Render staging is on the free plan,
schema-changing releases still require `prisma migrate deploy` against Neon
before the API or worker starts using the new schema. Move that command to a
Render pre-deploy step when the paid plan is enabled.

## Local verification

Run the code-quality gate locally with:

```bash
pnpm check
```

Before pushing a release-sensitive change, also run the affected tests and
builds. The GitHub workflow remains authoritative because it provisions clean
PostgreSQL and Redis services and runs the complete suite.
