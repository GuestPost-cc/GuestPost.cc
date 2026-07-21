# Repository Governance

## Overview

This document defines the governance model for the GuestPost monorepo.
It covers roles, decision-making processes, review expectations, and
escalation paths.

## Roles

| Role | Responsibility |
|------|---------------|
| **Maintainer** | Final decision authority. Reviews and merges PRs. Tracks the release process. |
| **Committer** | Can merge own PRs after review. Triage issues. |
| **Contributor** | Anyone submitting a PR or issue. |
| **Bot** | Automated accounts (Dependabot, etc.). |

## Decision-making

- **Day-to-day**: Maintainers + Committers use lazy consensus — if no
  objections within 48 hours on a PR, it may merge.
- **Architecture changes**: Require an ADR (see `docs/adr/`). Approval from
  at least 2 maintainers.
- **Breaking changes**: Require an ADR + minimum 1-week comment period.
- **Emergency fixes**: Can bypass normal review but must be followed by a
  post-mortem PR within 48 hours.

## PR Process

1. Open a PR against `main`.
2. Fill out the PR template.
3. Rebase on the latest `main` and ensure the required `build-and-test` check
   passes.
4. Request review from the relevant CODEOWNERS team and obtain at least one
   human approval.
5. Address feedback and resolve review threads. New commits invalidate stale
   approvals.
6. Squash-merge to `main`; direct pushes and force pushes are prohibited.

Repository administrators retain an audited break-glass bypass for incidents.
Using it for a non-emergency requires a follow-up review. Dependabot never has
a bypass and its PRs are not auto-merged.

Dependency updates also follow `docs/DEPENDENCY_POLICY.md`. Routine major
upgrades require a dedicated compatibility PR; critical security fixes use the
documented emergency lane.

## Release Process

1. Maintainer cuts a release branch from `main`.
2. Runs full CI including E2E tests.
3. Tags the release (`vX.Y.Z`).
4. Deploys to staging for smoke testing.
5. Deploys to production.

## CODEOWNERS

See `.github/CODEOWNERS` for the current ownership map. All changes
require approval from at least one owner of the affected directories.

## Maintenance Expectations

- Issues triaged within 1 week.
- PRs reviewed within 2 business days.
- Security vulnerabilities: immediate triage.
- Dependabot queue: review during the Tuesday maintenance window; keep no more
  than three routine npm update PRs open.
