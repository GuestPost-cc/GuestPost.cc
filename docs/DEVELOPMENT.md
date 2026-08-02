# Development

## Architecture

See `bedrock/Memory/ARCHITECTURE.md` for the canonical architecture
document. This file covers day-to-day development workflows.

## Monorepo structure

```
apps/
  api/          — NestJS backend
  admin/        — Admin dashboard (Next.js)
  portal/       — Customer portal (Next.js)
  publisher/    — Publisher dashboard (Next.js)
  website/      — Public website (Next.js)
  worker/       — Background job worker
packages/
  api-client/   — HTTP client for the GuestPost API
  auth/         — Auth utilities
  database/     — Prisma schema + client
  shared/       — Shared utilities and types
  ui/           — Shared UI component library
```

## Dev workflow

1. Start services: `pnpm services:up`
2. Build shared deps: `pnpm build --filter=@guestpost/shared --filter=@guestpost/database --filter=@guestpost/auth --filter=@guestpost/ui --filter=@guestpost/api-client`
3. With every API and worker process stopped, run migrations: `pnpm db:migrations:deploy`
4. Start individual app: `pnpm dev:portal` or `pnpm dev:api`

For the complete stack, `pnpm dev:all` starts infrastructure, removes stale
Next.js output before the production build, builds the workspace, checks
`pnpm db:migrations:status`, and removes production Next.js output before
launching the development servers. The two cleanup boundaries prevent stale
locks from blocking builds and prevent production route artifacts from hiding
valid development routes. Prisma returns a non-zero status for pending or
failed migrations, so startup fails closed rather than serving requests with
an incompatible generated client and database schema.

The status gate intentionally does not apply migrations automatically. Some
financial evidence migrations reject legacy writer shapes. If the gate fails,
stop all API and worker processes, run `pnpm db:migrations:deploy`, verify
`pnpm db:migrations:status`, and only then restart the stack. Never deploy those
migrations while an old API or worker is still writing.

## Testing

- API unit tests: `pnpm --filter @guestpost/api test`
- E2E tests: `npx playwright test`
- UI component tests: `pnpm --filter @guestpost/ui test:coverage`

## Before committing

Run `pnpm check` to verify:
- Biome format + lint + imports
- ESLint (React Hooks)
- TypeScript compilation
- Dependency graph

The pre-commit hook runs Biome on staged files automatically.
