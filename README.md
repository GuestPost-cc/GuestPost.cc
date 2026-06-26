# GuestPost Platform

A comprehensive guest post marketplace platform for SEO link building campaigns. Connect SEO experts with publishers for scalable, quality backlink acquisition.

## Architecture

### Apps (Next.js Frontends)

| App | Port | Description |
|-----|------|-------------|
| `website` | 3000 | Marketing landing page with features, pricing, testimonials |
| `portal` | 3001 | Customer dashboard for managing guest post campaigns |
| `publisher` | 3002 | Publisher dashboard for managing orders and payouts |
| `admin` | 3003 | Admin dashboard for platform management |

### Packages (Shared Libraries)

| Package | Purpose |
|---------|---------|
| `ui` | Shared React component library (Button, Card, Table, Dialog, etc.) |
| `api-client` | Type-safe API client for all backend services |
| `auth` | Better Auth integration for authentication |
| `database` | Prisma ORM schemas and client |
| `shared` | Shared types, enums, and constants |

### Backend Services

| Service | Description |
|---------|-------------|
| `api` | NestJS REST API (port 4000) |
| `worker` | Background job processor |

## Tech Stack

- **Frontend**: Next.js 15 (App Router), React 19, TypeScript
- **Backend**: NestJS, Prisma ORM, PostgreSQL
- **Infrastructure**: Docker (PostgreSQL, Redis, MinIO, Mailpit, Traefik)
- **Package Manager**: pnpm with Turborepo
- **UI Components**: Radix UI + custom components
- **Charts**: Recharts
- **Tables**: TanStack Table
- **Forms**: React Hook Form + Zod
- **Auth**: Better Auth with JWT + cookies

## Getting Started

### Prerequisites

- Node.js 18+
- pnpm 11+
- Docker (Compose v2)

### First-time setup

```bash
# 1. Install dependencies
pnpm install

# 2. Create the dev env file from the template
cp .env.example .env.development
# Adjust secrets as needed. The defaults already match the docker-compose stack.

# 3. Start infrastructure services (Postgres, Redis, MinIO, Mailpit, Traefik)
pnpm services:up

# 4. Build every package and app once. This also generates the Prisma client
#    and copies its native engine binary into packages/database/dist/prisma.
pnpm build
```

After step 4 the repo is ready to run.

### Development

```bash
# Run the full stack (all 4 Next apps + API + worker)
pnpm dev:all

# Or run a single piece
pnpm dev:api
pnpm dev:website     # 3000
pnpm dev:portal      # 3001
pnpm dev:publisher   # 3002
pnpm dev:admin       # 3003
pnpm dev:worker
```

`pnpm dev:*` is wired through Turborepo with `dependsOn: ["^build"]`, so workspace
dependencies (`@guestpost/database`, `@guestpost/shared`, …) are built before the
target app starts.

When you change the Prisma schema, regenerate the client:

```bash
pnpm --filter @guestpost/database db:generate
```

### Seed Test Data

```bash
pnpm seed   # Create admin user + test customers + publishers + orders
```

The seed script requires the API running on `:4000`.

### Environment Variables

All env vars live in `.env.development` at the repo root. The API loader at
[`apps/api/src/main.ts`](apps/api/src/main.ts) only reads that file when
`NODE_ENV=development` — the `dev` script sets it for you.

The minimum required keys (already present in `.env.example`):

| Key                  | Purpose                                              |
|----------------------|------------------------------------------------------|
| `DATABASE_URL`       | Postgres connection string (literal, no `${...}`)    |
| `REDIS_URL`          | Redis connection string                              |
| `JWT_SECRET`         | Better Auth / JWT signing key                        |
| `NEXT_PUBLIC_API_URL`| Public API origin used by the frontends              |

> **Note:** `dotenv` does **not** expand `${POSTGRES_USER}`-style placeholders.
> Always inline literal values in `DATABASE_URL`.

### Troubleshooting

- **`FATAL: Missing required environment variables`** — `.env.development` is
  missing, or you ran the API without `NODE_ENV=development`. Use `pnpm dev:api`
  (which sets it) or copy `.env.example` to `.env.development`.
- **`Cannot find module '.../dist/main.ts'`** — stale `apps/api/nest-cli.json`
  with `entryFile: "main.ts"`. It must be `"main"` (no extension).
- **`Prisma Client could not locate the Query Engine for runtime "..."`** — the
  native engine binary isn't in `packages/database/dist/prisma/`. Run
  `pnpm build` (or `pnpm --filter @guestpost/database build`) to regenerate
  and copy it.
- **`Authentication failed against database server`** — `DATABASE_URL`
  credentials don't match what Postgres was started with. The docker-compose
  defaults are `guestpost:guestpost`.

## Project Structure

```
guestpost-platform/
├── apps/
│   ├── api/              # NestJS API server
│   ├── admin/            # Admin dashboard (Next.js)
│   ├── portal/           # Customer portal (Next.js)
│   ├── publisher/        # Publisher portal (Next.js)
│   ├── website/          # Marketing site (Next.js)
│   └── worker/           # Background worker
├── packages/
│   ├── api-client/       # API client library
│   ├── auth/             # Auth integration
│   ├── database/         # Prisma schemas
│   ├── shared/           # Shared types
│   └── ui/               # Component library
├── docs/                # Developer documentation (setup, standards, governance, ADRs)
├── bedrock/             # Engineering knowledge base (architecture, business, audits, history)
├── infrastructure/
│   └── docker/           # Docker Compose configuration
└── scripts/             # Development workflow scripts (setup, check, doctor, seed, etc.)
```

## Key Features

### Customer Portal (localhost:3001)
- Campaign management
- Order creation and tracking
- Order reports and analytics
- Billing and wallet management
- Support ticket system

### Publisher Portal (localhost:3002)
- Website listing management
- Order acceptance and fulfillment
- Earnings tracking
- Withdrawal requests

### Admin Dashboard (localhost:3003)
- User management (customers, publishers, staff)
- Organization management
- Order oversight
- Settlement processing
- Withdrawal approval

## Dev Scripts

| Command | Purpose |
|---------|---------|
| `pnpm setup` | One-time dev environment setup (install, build, migrate, typecheck) |
| `pnpm doctor` | Diagnose environment — system, env vars, services, workspace, repo |
| `pnpm check` | Full pre-submit gate (Biome + ESLint + TypeScript + dependency graph) |
| `pnpm clean` | Remove build artifacts |
| `pnpm reset` | Full clean + reinstall + rebuild + DB reset |
| `pnpm seed` | Seed test data into a running API |

All scripts live in `scripts/`. See `docs/SETUP.md` and `docs/DEVELOPMENT.md` for details.

## API Endpoints

All API routes are prefixed with `/api/v1/`:

- `/auth/*` - Authentication (sign-in, sign-up, sign-out)
- `/identity/*` - User identity and organizations
- `/orders/*` - Order management
- `/campaigns/*` - Campaign management
- `/marketplace/*` - Publisher/website discovery
- `/billing/*` - Wallet and transactions
- `/publisher-payouts/*` - Publisher earnings and withdrawals
- `/support/*` - Support tickets
- `/admin/*` - Admin operations
- `/reporting/*` - Analytics and exports

## License

ISC
