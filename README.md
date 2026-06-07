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
| `billing` | Billing utilities (placeholder) |
| `notifications` | Notification utilities (placeholder) |
| `reporting` | Reporting utilities (placeholder) |

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
- Docker

### Installation

```bash
# Install dependencies
pnpm install

# Start infrastructure services
pnpm services:up

# Build all packages and apps
pnpm build
```

### Development

```bash
# Start all services in development mode
pnpm dev:all

# Start individual app
pnpm dev:website
pnpm dev:portal
pnpm dev:publisher
pnpm dev:admin

# Start only the API
pnpm dev:api
```

### Seed Test Data

```bash
pnpm seed:admin   # Create admin user
pnpm seed:users   # Create test customers and publishers
```

### Environment Variables

Create `.env.development` in the root with:

```env
# Database
DATABASE_URL=postgresql://guestpost:guestpost@localhost:5432/guestpost

# Redis
REDIS_URL=redis://localhost:6379

# API URL for frontend apps
NEXT_PUBLIC_API_URL=http://localhost:4000

# Auth
JWT_SECRET=your-secret-key
```

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
├── infrastructure/
│   └── docker/           # Docker Compose configuration
└── scripts/             # Seed scripts
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

## Recent Fixes

- **API URL Configuration**: Fixed `NEXT_PUBLIC_API_URL` to use `http://localhost:4000` without `/api/v1` suffix; api.ts files now correctly append `/api/v1`
- **Select Component**: Changed empty string SelectItem values to `"all"` to prevent Radix validation errors
- **Null Safety**: Added optional chaining and null coalescing for wallet balance and pagination state
- **Cell Rendering**: Fixed TanStack Table cell rendering with proper type checks
- **Rate Limiting**: Disabled rate limiters in development mode
- **Publisher Balance API**: Fixed `getBalance()` to accept `publisherId` parameter

## TODO

- [ ] Database seeding and migrations
- [ ] Email integration with Mailpit
- [ ] Stripe payment integration
- [ ] Real-time notifications
- [ ] API key management UI
- [ ] Email verification flow
- [ ] Password reset flow
- [ ] Complete test coverage

## License

ISC