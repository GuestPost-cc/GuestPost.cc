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

- All endpoints validate input via Zod schemas or DTOs.
- Authentication: Better Auth (session + JWT).
- Authorization: role-based access control (SUPER_ADMIN, OPERATIONS,
  OWNER, MEMBER).
- Rate limiting: applied at the API gateway / reverse proxy level.
- CORS: configured per-environment, production allows only known origins.

## Web security

- Content-Security-Policy headers.
- XSS protection via `isomorphic-dompurify` for user-generated content.
- CSRF protection via SameSite cookies and token-based auth.

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
