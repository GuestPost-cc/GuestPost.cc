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
3. Run migrations: `pnpm --filter @guestpost/database exec prisma migrate deploy`
4. Start individual app: `pnpm dev:portal` or `pnpm dev:api`

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
