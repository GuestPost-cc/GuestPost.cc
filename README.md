# GuestPost Platform

A comprehensive guest post marketplace platform for SEO link building campaigns. Connect SEO experts with publishers for scalable, quality backlink acquisition.

## Architecture

### Apps (Next.js Frontends)

| App | Port | Description |
|-----|------|-------------|
| `website` | 3000 | Public marketing, pricing, documentation, legal, and auth entry site |
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

- **Frontend**: Next.js 16 (App Router), React 19, TypeScript
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

- Node.js 20.9+
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

# 5. With every API and worker process stopped, apply committed migrations.
pnpm db:migrations:deploy
```

After step 5 the repo is ready to run.

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

# Verify that every public documentation route is registered
pnpm check:website-docs
```

`pnpm dev:*` is wired through Turborepo with `dependsOn: ["^build"]`, so workspace
dependencies (`@guestpost/database`, `@guestpost/shared`, …) are built before the
target app starts.

`pnpm dev:all` loads only `.env.development` (while preserving explicit shell
overrides), clears generated Next.js state before the production build and
again before the development servers, then runs
`pnpm db:migrations:status` before it starts any API, worker, or web process.
The first cleanup removes stale build locks; the second prevents production
route artifacts from hiding valid development routes. The preflight build
force-refreshes ignored workspace `dist/` outputs so stale declarations cannot
survive a branch switch, then uses production `NODE_ENV` semantics and the
local API origin from the development environment. No inline
`NEXT_PUBLIC_API_URL=...` prefix is needed. It does not load `.env` or apply
migrations automatically. Pending or failed migrations stop startup instead of
allowing new application code to run against an older schema. Stop every
running API and worker before
`pnpm db:migrations:deploy`; financial evidence migrations are not guaranteed
to be compatible with old writers.

Public website architecture, documentation maintenance, discovery endpoints,
security boundaries, and release checks are documented in
[`docs/PUBLIC_WEBSITE.md`](docs/PUBLIC_WEBSITE.md).

When you change the Prisma schema, regenerate the client:

```bash
pnpm --filter @guestpost/database db:generate
```

### Seed Test Data

```bash
pnpm seed   # Create local-only fixture users, listings, and wallet funding
```

The seed script requires the local API on `http://localhost:4000`. It refuses
production/staging modes, remote API targets, and remote database targets
because it creates known-password identities and synthetic money evidence. Run
`pnpm services:up` first; that command installs the database-side local
development sentinel required by the seed. The seed proves its direct Prisma
connection and the loopback API resolve to the same PostgreSQL cluster/database
identity, verifies every fixture credential through its intended portal, and
revokes every session it creates.

Demo publisher sites use reserved `.example` domains. They are never recorded
as DNS-verified: the local-only seed writes an explicit, audited, expiring
`SUPER_ADMIN_OVERRIDE` so checkout can be exercised without weakening the
production ownership gate. The fixture creates no settlement-backed publisher
earnings, payout method, or provider-account evidence, so it is intentionally
not eligible for a successful payout.

### Environment Variables

All env vars live in `.env.development` at the repo root. The API loader at
[`apps/api/src/main.ts`](apps/api/src/main.ts) only reads that file when
`NODE_ENV=development` — the `dev` script sets it for you.

The minimum required keys (already present in `.env.example`):

| Key                  | Purpose                                              |
|----------------------|------------------------------------------------------|
| `DATABASE_URL`       | Postgres connection string (literal, no `${...}`)    |
| `REDIS_URL`          | API cache/rate-limit Redis connection                 |
| `QUEUE_REDIS_URL`    | Optional dedicated BullMQ Redis (falls back above)    |
| `JWT_SECRET`         | Better Auth / JWT signing key                        |
| `NEXT_PUBLIC_API_URL`| Public API origin used by the frontends              |
| `NEXT_PUBLIC_WEBSITE_URL` | Canonical public website origin                |
| `NEXT_PUBLIC_BLOG_URL` | Independently hosted WordPress journal origin      |
| `NEXT_PUBLIC_PORTAL_URL` | Customer application origin                     |
| `NEXT_PUBLIC_PUBLISHER_URL` | Publisher application origin                 |

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

Production worker lanes, payout recovery, and Northflank job setup are covered
in [`docs/WORKER_ARCHITECTURE.md`](docs/WORKER_ARCHITECTURE.md).

The port `3000` design system, content rules, WordPress boundary, security
headers, CSP, crawler files, legal launch gate, and release checklist are
documented in
[`docs/PUBLIC_WEBSITE.md`](docs/PUBLIC_WEBSITE.md).

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
| `pnpm seed` | Seed local-only test data into the local API and database |

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
