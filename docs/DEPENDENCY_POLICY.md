# Dependency Policy

## Objective

Dependabot proposes dependency changes; CI, repository rules, and a human
maintainer decide whether they are safe. Availability and security take
priority over update volume. Dependency PRs are never auto-merged by default.

The update system is intentionally reusable:

- `.github/dependabot.yml` controls schedule, cooldowns, major-version policy,
  and compatible update groups.
- `.github/dependency-policy.json` lists compatibility relationships that CI
  must enforce.
- `scripts/check-dependency-policy.ts` checks aligned declarations, resolved
  singleton packages, advisory-driven minimum versions, and workspace-override
  drift.
- `.github/workflows/ci.yml` runs GitHub dependency review, a frozen install,
  the compatibility policy, the production audit, tests, and builds.

When a new fragile dependency relationship is discovered, update the JSON
policy and its Dependabot group in the same PR.

## Principles

1. **Minimal surface**: only add a dependency when the cost of writing and
   maintaining equivalent code exceeds the dependency's lifecycle risk.
2. **Locked versions**: `pnpm-lock.yaml` is committed and CI installs it with
   `--frozen-lockfile`.
3. **No floating ranges**: use exact or caret-compatible versions, never `*`
   or `latest` in package manifests.
4. **Compatible cohorts**: packages that share runtime types, clients, or
   adapters must update and test together.
5. **Human release control**: no automatic merge for runtime updates. Merge
   one runtime dependency PR at a time and observe the deployment.
6. **Security bypasses routine delay**: Dependabot cooldown and routine-major
   suppression do not delay security updates.

## Allowed dependency categories

- **Runtime**: Next.js, React, NestJS, Prisma, Redis, Zod, TanStack Query,
  Sentry, date-fns.
- **Dev**: TypeScript, ESLint, Biome, Turborepo, Playwright, Vitest,
  dependency-cruiser, Husky, lint-staged.
- **Infrastructure**: Docker images (Postgres, Redis).

## Prohibited dependencies

- [Leftpad](https://en.wikipedia.org/wiki/Npm_left-pad)-style single-function
  packages (write the function yourself).
- Abandoned or unmaintained packages.
- Packages with known CVEs that lack a fix release.

## Adding a dependency

1. Evaluate: is this package well-maintained, documented, and tested?
2. Check: does it introduce transitive dependencies with build scripts?
3. Approve: PR must be reviewed by a maintainer.
4. Add: `pnpm add <package>` (for runtime) or `pnpm add -D <package>` (for dev).
5. Pin: `pnpm-lock.yaml` captures the exact version.

The PR must also pass dependency review. New dependencies with a known high or
critical vulnerability are rejected before installation.

## Removing a dependency

When removing a dependency, also check:
- `pnpm-lock.yaml` — does the prune remove transitive deps?
- `allowBuilds` in `pnpm-workspace.yaml` — can the build approval be removed?
- `onlyBuiltDependencies` in `package.json` — can it be removed?
- CI — does the configuration reference the removed package?

## Dependabot lanes

### Security updates

Security updates remain individual PRs so an unrelated failure cannot block a
critical fix. They do not wait for the routine cooldown.

| Severity | Acknowledge | Target remediation |
|----------|-------------|--------------------|
| Critical | Within 1 hour | Same day when a supported fix exists |
| High | Within 1 business day | Within 3 business days |
| Moderate | During the next weekly maintenance window | Next safe release |
| Low | Monthly review | Planned maintenance |

If the supported security fix requires a major upgrade, create a dedicated
compatibility PR rather than weakening CI or ignoring the alert. Record any
temporary exception with an owner, reason, expiry date, and compensating
control.

### Routine version updates

- Dependabot checks npm on Tuesday at 10:00 Asia/Dhaka.
- At most three routine npm PRs stay open.
- Patch releases cool down for 7 days; minor releases and uncategorized
  releases cool down for 14 days.
- Routine SemVer major updates are suppressed and handled as planned migration
  PRs, normally during the quarterly dependency review.
- Docker and GitHub Actions updates run monthly with one open PR per ecosystem.
- The repository labels `dependencies`, `docker`, and `ci` are part of this
  configuration and must remain available for bot-authored PRs.

## Review and release procedure

1. Classify the PR as security, development tooling, or runtime.
2. Rebase it on the latest `main`; approvals become stale after new commits.
3. Read upstream release notes and inspect both manifest and lockfile changes.
4. Confirm every compatibility cohort changed together. Never bypass
   `pnpm deps:policy` to make a partial update green.
5. Require the `build-and-test` check and one human approval. A bot approval is
   not sufficient.
6. Squash-merge only one runtime dependency PR at a time.
7. Verify the deployed commit and its relevant smoke surface, then monitor
   errors, latency, queue failures, and authentication for 30–60 minutes before
   merging another runtime update.
8. If health regresses, revert the merge commit and redeploy the last known
   good commit. Do not repair production by editing the lockfile manually.

Suggested smoke ownership:

| Dependency area | Required smoke surface |
|-----------------|------------------------|
| Helmet/auth | Login, session, CSP/CORS, API readiness |
| BullMQ/ioredis | Realtime worker plus scheduled/on-demand jobs |
| AWS S3/Smithy | Presigned upload and download |
| Next/React/Radix/PostCSS | All four web builds and affected UI flow |
| Hook Form/resolvers | Login, billing, inventory, and order forms |
| Sentry | API/worker startup and frontend error capture initialization |

## Initial queue reconciliation (2026-07-22)

This table records why the pre-policy queue was retained or superseded. It is a
historical migration snapshot, not a permanent allowlist.

| PR | Update | Disposition under this policy |
|----|--------|-------------------------------|
| #62 | Sentry 10.63 → 10.67 | Close: partial direct SDK cohort and release-age failure; recreate only when Node and Next SDKs align. |
| #63 | ESLint tooling | Automatically closed after the old group was replaced by the `eslint-tooling` cohort; no stale branch remains. |
| #64 | TypeScript 6 → 7 group | Close: routine major and incompatible with the current TypeScript-ESLint stack. |
| #65 | Helmet 8.2 → 8.3 | Automatically closed when the 14-day minor-release cooldown made 8.3 temporarily ineligible; recreate after cooldown and rerun auth/header smoke tests. |
| #66 | AWS S3 client only | Close: client/presigner update split the Smithy type graph. |
| #67 | Radix Dialog patch | Close: recreate in the Radix patch cohort after cooldown. |
| #68 | PostCSS 8.5.20 | Superseded here: the old PR did not update the workspace override, so its green CI tested 8.5.10. |
| #69 | Hook Form resolvers 3 → 5 | Close: routine major and current portal form typing fails. |
| #70 | Radix Switch patch | Close: recreate in the Radix patch cohort after cooldown. |
| #71 | BullMQ only | Close: it introduced a second ioredis type/runtime version. |

All PRs in this initial queue are closed and their remote branches are deleted.
Routine eligible updates will be recreated by the scheduled cohorts; security
updates remain exempt from the routine delay.

## Transitive security overrides

`pnpm-workspace.yaml` may temporarily raise a transitive dependency above the
range declared by its parent when no upstream release has adopted the patched
version. Each such override must have a corresponding minimum version in
`.github/dependency-policy.json`, pass the full build, and be removed when the
upstream range catches up. Current advisory floors are:

- PostCSS 8.5.10 for GHSA-qx2v-qp2m-jg93
- fast-uri 3.1.4 for GHSA-v2hh-gcrm-f6hx
- Sharp 0.35.0 for GHSA-f88m-g3jw-g9cj
- Hono Node Server 2.0.5 for GHSA-frvp-7c67-39w9
