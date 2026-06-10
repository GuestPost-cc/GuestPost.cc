---
note_type: project-overview
project: guestpost-platform
updated: 2026-06-10
---

# Project

## What this project is
Multi-tenant marketplace platform connecting customers (buyers of guest posts/backlinks) with publishers (website owners who publish content). Includes wallet-based payment system, order fulfillment workflow, settlement/payout system, and marketplace listings.

Stack: NestJS API + Next.js frontends (portal, publisher, admin, website) + BullMQ workers + PostgreSQL + Redis + MinIO.

## Architecture decisions
- **ActiveContext over Better-Auth session attributes**: decoupled from auth provider, immediate context changes, easy to query/validate
- **Version-based optimistic concurrency** on Wallet, PublisherBalance, Settlement — prevents race conditions without pessimistic locks
- **Transaction.reference @@unique**: database-level duplicate prevention for webhooks
- **Business-action endpoints** replace generic status transitions — each action validates actor type, org ownership, status, and business rules
- **Settlement dual-approval**: both customer + admin must approve before release; dispute blocks release
- **ActorTypeGuard**: separates CUSTOMER, PUBLISHER, and STAFF domains at controller/endpoint level

## Project structure
- `apps/api` — NestJS REST API (auth, billing, orders, marketplace, campaigns, settlements, admin, etc.)
- `apps/worker` — BullMQ background jobs (email, notification, report, verification)
- `apps/portal` — Customer portal (Next.js)
- `apps/publisher` — Publisher dashboard (Next.js)
- `apps/admin` — Staff admin panel (Next.js)
- `apps/website` — Public marketing site (Next.js)
- `packages/database` — Prisma schema + client (50 models)
- `packages/shared` — Types, constants, queue configs

## Key domains
- **Identity/Org**: Multi-tenant orgs with CUSTOMER (OWNER/MEMBER), PUBLISHER (PUBLISHER_OWNER/MEMBER), and STAFF user types
- **Billing**: Wallet-based payments with Stripe integration; reserve→capture→release pattern
- **Orders**: Full lifecycle from DRAFT→COMPLETED with business-action endpoints and status machine
- **Marketplace**: Listing discovery, reviews, favorites, searches
- **Settlements**: Dual-approval settlement with platform fee (20%), tier-based review windows
- **Publisher Payouts**: Withdrawal requests with tier-based holds (NEW=30d, TRUSTED=14d, VERIFIED=7d)

## Guard architecture
- `AuthGuard` (global) — validates session, sets user from ActiveContext
- `ActorTypeGuard` — enforces @ActorType("CUSTOMER"|"PUBLISHER"|"STAFF")
- `MemberRolesGuard` — enforces @MemberRoles("OWNER"|"MEMBER"|"PUBLISHER_OWNER"|"PUBLISHER_MEMBER")
- `StaffRolesGuard` — enforces @StaffRoles("SUPER_ADMIN"|"OPERATIONS"|"FINANCE")
- `OrderOwnershipGuard` — validates resource orgId/publisherId matches user context
- `@Public()` — skips AuthGuard

## Security
- C1 (Critical): Stripe webhook dummy mode removed — all environments require real Stripe keys
- C2 (Critical): Verification worker auth to be fixed — workers must validate order ownership
- All critical statuses (PAID, ACCEPTED, VERIFIED, SETTLED, COMPLETED, REFUNDED) are system-only
- No first-membership-wins — all context from ActiveContext table
