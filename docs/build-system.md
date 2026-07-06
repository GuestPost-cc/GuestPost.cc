# GuestPost Build System

## Tooling stack

- **pnpm 11** — workspace package manager
- **Turbo 2** — task orchestration and caching
- **TypeScript 6** — with project references
- **Jest 29** — unit + integration test runner
- **Sentry** — error tracking and source-map upload

## turbo.json environment variables

### SENTRY_AUTH_TOKEN

Listed in both `turbo.json` `globalEnv` and `build.env` because Turbo hashes
environment variables that affect build output. The Sentry source-map upload
step runs at build time and requires this token to authenticate with Sentry's
API. Without the token, builds still succeed — the upload phase is silently
skipped.

The token is set in CI via GitHub secrets and is never logged or leaked by the
build pipeline. Each app's `next.config.ts` gates source-map generation on its
presence:

```ts
sourcemaps: { disable: !process.env.SENTRY_AUTH_TOKEN }
```

See `.env.example:114-122` for setup instructions and `pnpm-workspace.yaml:15-20`
for the build-script configuration.

## Task pipeline

```
build (11 targets)
  ├── packages/database    — Prisma generate + tsc
  ├── packages/shared      — tsc
  ├── packages/ui          — tsc + tailwind
  ├── packages/api-client  — tsc
  ├── apps/worker          — tsc
  └── apps/api             — tsc (NestJS)
  └── apps/*               — next build (4 Next.js apps, include Sentry upload)

test
  ├── packages/shared      — jest (29 tests)
  └── apps/api             — jest projects: unit (754 tests) + integration

lint
  └── biome check — all packages
```

## Adding a new environment variable to the hash

If a new env var affects build output (e.g., a feature flag that changes
bundled code), add it to `turbo.json` under both `globalEnv` and any
task-specific `env` arrays so Turbo invalidates the cache correctly.
