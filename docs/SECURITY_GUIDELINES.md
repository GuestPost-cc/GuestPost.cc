# Security Guidelines

## General principles

- Least privilege: every API key, token, and role should have the minimum
  permissions needed.
- Defence in depth: validate at the edge (API gateway), in the handler
  (middleware), and in the service layer.
- No secrets in code: API keys, tokens, and database URLs come from
  environment variables or secrets manager.
- HTTPS everywhere in production.

## Secrets management

- Secrets are stored in environment variables (`.env.*` files,
  GitHub Actions secrets, deployment platform secrets).
- `.env.development` is gitignored. `.env.example` provides the schema.
- Production secrets are never committed to the repository.
- If a secret is exposed, rotate it immediately and audit the exposure.

## API security

- HTTP inputs must use bounded DTO/schema validation; service validation must
  also protect direct and background callers where the same rule applies.
- Authentication: Better Auth sessions for people; creator-bound,
  organization-scoped API keys only on explicitly opted-in automation routes.
- Authorization: live customer, publisher, and staff authority is resolved on
  each protected request, then enforced by guards, service checks, explicit
  projections, and PostgreSQL RLS when enabled.
- API-key requests reject mixed cookie/Authorization credentials, remain on
  the anonymous rate-limit tier until authenticated, and require exact route
  permissions. See `docs/API_KEY_SECURITY.md`.
- Rate limiting: environment-aware in-process limits cover auth, anonymous and
  authenticated API traffic, marketplace, admin, billing, webhooks, and
  verification triggers. The gateway is an additional layer, not the only one.
- CORS: configured per-environment, production allows only known origins.

## Web security

- Content-Security-Policy headers.
- XSS protection via `isomorphic-dompurify` for user-generated content.
- Cookie-authenticated mutations use SameSite cookies, trusted Origin/Referer
  checks, Fetch Metadata checks, and the non-simple `X-CSRF-Protection` header.
  API-key clients omit cookies and follow the same-origin HTTPS transport
  contract documented in `docs/API_KEY_SECURITY.md`.

## Data and background-work boundaries

- RLS covers customer, publisher, staff, auth, webhook, worker, and catalog
  workloads, but is activated only through the guarded procedure in
  `docs/RLS_ROLLOUT.md`.
- RLS is row isolation, not column masking. Public and cross-role responses
  must continue using explicit field selections and audience projections.
- Bounded query and sweep rules, including N+1 prevention, deterministic
  paging, cursor fairness, and write-boundary reauthorization, are in
  `docs/QUERY_AND_WORKER_HARDENING.md`.

## Dependency security

- Dependabot security updates are enabled and are not delayed by the routine
  update cooldown or routine-major suppression.
- Critical alerts are acknowledged within one hour and remediated the same day
  when a supported fix exists; high alerts target three business days.
- GitHub dependency review blocks PRs that introduce high or critical known
  vulnerabilities, and `pnpm audit` blocks moderate-or-higher production
  vulnerabilities.
- Routine npm updates run weekly with a three-PR cap; Docker and GitHub Actions
  updates run monthly.
- Runtime dependency PRs require a human approval and are deployed one at a
  time. See `docs/DEPENDENCY_POLICY.md` for compatibility groups, smoke tests,
  and rollback.
- Only built-in dependencies are allowed (see `pnpm-workspace.yaml`'s
  `onlyBuiltDependencies`).
