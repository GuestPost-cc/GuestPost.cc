# Setup

## Prerequisites

- **Node.js** >= 20.9 (use [fnm](https://github.com/Schniz/fnm) or nvm)
- **pnpm** >= 8 (install via `corepack enable && corepack prepare pnpm@latest --activate`)
- **Docker** (for local Postgres + Redis)
- **Git**

## One-time setup

```bash
git clone <repo-url>
cd GuestPost.cc
pnpm setup
```

This runs:
1. `pnpm install`
2. Prisma client generation
3. Build shared packages
4. Database migrations
5. TypeScript check
6. Format and lint check

## Start development

```bash
pnpm dev:all
```

This starts all services: API, worker, and all four Next.js apps.

Startup clears stale Next.js output on both sides of the production build,
checks the committed Prisma migration history before launching any application
process, and exits if a migration is pending or failed. When that happens,
stop every API and worker, run `pnpm db:migrations:deploy`, and rerun
`pnpm dev:all`. This hard-drain boundary is required for financial evidence
migrations that may reject writes from older application code.

## Quick reference

| Command | What it does |
|---------|-------------|
| `pnpm dev` | Start all dev servers |
| `pnpm build` | Build all packages |
| `pnpm check` | Run full pre-submit gate |
| `pnpm clean` | Remove build artifacts |
| `pnpm reset` | Full reset + fresh install |
| `pnpm doctor` | Check system requirements |
| `pnpm db:migrations:status` | Fail if committed migrations are pending or failed |
| `pnpm db:migrations:deploy` | Apply committed migrations while app writers are stopped |
