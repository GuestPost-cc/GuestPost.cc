# Setup

## Prerequisites

- **Node.js** >= 18 (use [fnm](https://github.com/Schniz/fnm) or nvm)
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

## Quick reference

| Command | What it does |
|---------|-------------|
| `pnpm dev` | Start all dev servers |
| `pnpm build` | Build all packages |
| `pnpm check` | Run full pre-submit gate |
| `pnpm clean` | Remove build artifacts |
| `pnpm reset` | Full reset + fresh install |
| `pnpm doctor` | Check system requirements |
