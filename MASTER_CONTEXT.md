# MASTER_CONTEXT.md - GuestPost.cc

**GuestPost.cc** is an SEO Operating System built as a monorepo. Current phase: **Marketplace Platform** evolving toward **Authority Building Platform**.

---

## Architecture Summary

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 15, React 19, TypeScript, Tailwind, TanStack Query, Radix UI |
| Backend | NestJS, Prisma ORM |
| Database | PostgreSQL |
| Queue/Cache | Redis, BullMQ |
| Auth | better-auth |
| Monorepo | TurboRepo + pnpm |

### Apps (6)
- **website** (port 3000) - Public marketing site
- **portal** (port 3001) - Client dashboard
- **publisher** (port 3002) - Publisher dashboard
- **admin** (port 3003) - Staff admin panel
- **api** (port 4000) - REST API (NestJS)
- **worker** (port 4001) - Background jobs (BullMQ)

### Packages (5)
- **ui** - React component library (Radix UI based)
- **database** - Prisma client, generated enums/models
- **shared** - Types, constants, queue definitions
- **auth** - better-auth helpers
- **api-client** - Typed HTTP client

---

## Business Model

### Revenue
- **Marketplace commission**: 15% on transactions (configurable)
- **Direct services**: Pre-defined guest posts, niche edits, editorial links
- **Future**: Subscription plans (Free → Enterprise)

### Order Flow
```
DRAFT → PENDING_PAYMENT → PAID → ASSIGNED → CONTENT_CREATION → OUTREACH → PUBLISHED → VERIFIED → SETTLED → COMPLETED
```

### Wallet System
- Organizations have Wallets
- Reserve funds on order creation
- Capture on payment
- Refunds return to available balance

### Publisher Settlement
```
Order verified → Settlement auto-created → 7-day window → Approved → Balance updated → Withdrawal available
```

---

## Data Model

### Core Entities
- **User** → belongs to Organization or Publisher
- **Organization** → tenant root, has Wallets, Orders, Campaigns
- **Publisher** → manages Websites, has Balance, Profile
- **Website** → publisher's site with metrics
- **Order** → core transaction with status lifecycle
- **Campaign** → groups Orders

### Marketplace
- **MarketplaceListing** → unified for INTERNAL and PUBLISHER types
- **MarketplaceCategory** → hierarchical categories
- **MarketplaceTag** → flat tags
- **MarketplaceReview** → user reviews with ratings
- **MarketplaceFavorite/SavedList** → user curation

### Finance
- **Wallet** → available + reserved balances
- **Transaction** → DEPOSIT, WITHDRAWAL, CHARGE, REFUND, SETTLEMENT
- **Settlement** → publisher payment record
- **Withdrawal** → publisher payout request

---

## API Architecture

**Base**: `http://localhost:4000/api/v1`

### Authentication
- Session cookies via better-auth
- `AuthGuard` populates `request.user` with full context
- Multi-tenant: `user.organizationId`, `user.publisherId`, `user.staffRole`

### Key Endpoints

| Resource | Endpoints |
|----------|-----------|
| marketplace | GET /listings, GET /listings/:slug, GET /categories, POST /favorites |
| orders | POST /, GET /, GET /:id, PATCH /:id/status |
| campaigns | POST /, GET /, GET /:id, PUT /:id |
| billing | GET /wallet, POST /deposit, POST /withdrawal |
| publishers | POST /, GET /:id, POST /:id/websites |
| admin | GET /users, GET /orders, GET /settlements |

### API Client Usage
```typescript
import { api } from "@/lib/api"
// Returns Promise directly - NO .data wrapper
const listing = await api.marketplace.getListing(slug)
```

---

## Frontend Structure

### Portal Routes
- `/dashboard` - Overview
- `/dashboard/orders` - Order management
- `/dashboard/campaigns` - Campaign grouping
- `/dashboard/marketplace` - Browse/search listings
- `/dashboard/marketplace/[slug]` - Listing detail
- `/dashboard/billing` - Wallet/deposits
- `/dashboard/reports` - Analytics
- `/dashboard/support` - Tickets

### Admin Routes
- `/dashboard` - Platform stats
- `/dashboard/users` - User management
- `/dashboard/organizations` - Org management
- `/dashboard/orders` - All orders
- `/dashboard/marketplace` - Listing moderation
- `/dashboard/finance` - Settlements/withdrawals

### Patterns
- **Client Components**: `"use client"` directive
- **API Calls**: TanStack Query + api client
- **Forms**: React Hook Form + Zod
- **Tables**: TanStack Table + flexRender for headers
- **Styling**: Tailwind + cn() utility

---

## Module Inventory (14 modules)

| Module | Status | Purpose |
|--------|--------|---------|
| auth | Complete | Session management via better-auth |
| identity | Complete | Org/team/user management |
| marketplace | Complete | Listings, search, categories, reviews |
| orders | Complete | Full order lifecycle |
| campaigns | Complete | Order grouping |
| billing | Complete | Wallet, deposits, withdrawals |
| settlements | Complete | Publisher payment workflow |
| publisher-payouts | Complete | Balance, withdrawals |
| reporting | Partial | Analytics endpoints |
| support | Complete | Ticket system |
| api-keys | Complete | Organization API access |
| admin | Complete | Staff admin operations |
| audit | Complete | Action logging |
| queues | Partial | BullMQ setup |

---

## Current Status

### Complete
- Core architecture (monorepo, API, database)
- Auth system with RBAC
- Full order workflow
- Marketplace with search/filters/reviews
- Publisher management
- Wallet and billing
- Admin dashboard
- Marketing website

### In Progress
- Worker/queue processing (stubbed)
- Email notifications
- Reporting UI

### Not Started
- WebSocket notifications
- Elasticsearch (using Postgres FTS)
- Stripe payment integration
- PDF report export
- Website crawler (auto-fetch metrics)
- Dark mode
- Mobile responsive polish
- i18n
- AI recommendations production

---

## Critical Patterns

1. **Prisma**: Always add reverse relation fields on both models
2. **API Client**: Returns JSON directly (no `.data` wrapper)
3. **TanStack Table**: Use flexRender for headers, not string cast
4. **Multi-tenancy**: Filter by `organizationId` for all customer data
5. **Dev mode**: Rate limiting disabled in `main.ts`
6. **API URL**: `NEXT_PUBLIC_API_URL=http://localhost:4000` + `/api/v1` in api.ts

---

## Important Commands

```bash
# Dev
pnpm dev                     # All apps
pnpm --filter portal dev     # Portal only

# Build  
pnpm build                   # All
pnpm --filter api build      # API only

# Database
pnpm --filter @guestpost/database db:generate  # After schema change
pnpm --filter @guestpost/database db:push     # Push schema (dev)

# Typecheck
pnpm --filter portal tsc --noEmit
pnpm --filter admin tsc --noEmit
```

---

## File Quick Reference

| What | Path |
|------|------|
| Database schema | `packages/database/prisma/schema.prisma` |
| API modules | `apps/api/src/modules/[module]/` |
| API client | `packages/api-client/src/services/` |
| UI components | `packages/ui/src/components/` |
| Portal pages | `apps/portal/src/app/dashboard/` |
| Auth guard | `apps/api/src/modules/auth/auth.guard.ts` |
| Main entry | `apps/api/src/main.ts` |

---

## Next Phase Goals

1. **Worker Implementation** - Real queue processing
2. **Email System** - Transactional emails via queue
3. **Payment Integration** - Stripe for deposits/withdrawals
4. **Publication Verification** - Automated link checking
5. **AI Layer** - Recommendation engine
6. **Metrics Crawler** - Auto-fetch DR/traffic data