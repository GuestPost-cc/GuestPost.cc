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

- Dependabot runs weekly for npm, Docker, and GitHub Actions dependencies.
- Critical security updates are prioritised over feature work.
- `pnpm audit` runs in CI to detect known vulnerabilities.
- Only built-in dependencies are allowed (see `pnpm-workspace.yaml`'s
  `onlyBuiltDependencies`).
