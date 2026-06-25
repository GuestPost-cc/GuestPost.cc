# Repository Manifest

## Quick facts

| Property | Value |
|----------|-------|
| **Name** | GuestPost Platform |
| **Package manager** | pnpm 11.5.1 |
| **Node.js** | 22+ |
| **TypeScript** | 5.7 |
| **Framework** | Next.js 15 (apps), NestJS (API) |
| **Database** | PostgreSQL 17 via Prisma |
| **Cache** | Redis 7 |
| **Task orchestrator** | Turborepo 2.9 |
| **Formatter/linter** | Biome 2.5 |
| **Legacy linter** | ESLint 9 (React Hooks only) |
| **CI** | GitHub Actions |

## Key files

| File | Purpose |
|------|---------|
| `turbo.json` | Task orchestration pipeline |
| `biome.json` | Formatting + linting + import config |
| `eslint.config.mjs` | ESLint (React Hooks + type-aware rules) |
| `.dependency-cruiser.js` | Architecture boundary enforcement |
| `lint-staged.config.js` | Pre-commit hook tasks |
| `docs/REPOSITORY_CONTRACT.md` | Repository constitution |
| `docs/TOOLCHAIN.md` | Toolchain division of labour |

## Workspace packages

| Package | Type | Description |
|---------|------|-------------|
| `@guestpost/api` | App | NestJS backend |
| `@guestpost/admin` | App | Admin dashboard |
| `@guestpost/portal` | App | Customer portal |
| `@guestpost/publisher` | App | Publisher dashboard |
| `@guestpost/website` | App | Public website |
| `@guestpost/worker` | App | Background worker |
| `@guestpost/api-client` | Package | HTTP client |
| `@guestpost/auth` | Package | Auth utilities |
| `@guestpost/database` | Package | Prisma schema + client |
| `@guestpost/shared` | Package | Shared utilities |
| `@guestpost/ui` | Package | UI component library |
