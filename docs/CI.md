# CI/CD

## Pipelines

### `ci.yml` (push to main + PR)

Runs on every push to `main` and every pull request:
1. Build shared dependencies
2. Run database migrations
3. Biome check (format + lint + imports)
4. ESLint (React Hooks + TS rules)
5. Dependency graph validation (dependency-cruiser)
6. TypeScript type check
7. API unit tests (+ UI coverage)
8. Full production build

### `pr.yml` (PR only)

Lightweight PR gate:
1. Build shared dependencies
2. Run database migrations
3. TypeScript type check
4. Biome check
5. ESLint
6. Dependency graph validation
7. API unit tests

## Secrets

| Secret | Purpose |
|--------|---------|
| `SENTRY_AUTH_TOKEN` | Source map upload (optional — build succeeds without) |
| `SENTRY_ORG` | Sentry org |
| `SENTRY_PROJECT` | Sentry project |

## Local CI simulation

```bash
pnpm check
```

This runs the same checks as CI.
