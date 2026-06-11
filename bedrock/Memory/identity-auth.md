---
note_type: domain-memory
domain: identity-auth
project: guestpost-platform
updated: 2026-06-11
---

# Identity & Auth

## User Model

Three actor types enforced via `ActorTypeGuard`:
- **CUSTOMER** — buyers of guest posts (OWNER / MEMBER roles) via `MemberRolesGuard`
- **PUBLISHER** — content providers (PUBLISHER_OWNER / PUBLISHER_MEMBER roles)
- **STAFF** — platform operators (SUPER_ADMIN / OPERATIONS / FINANCE roles) via `StaffRolesGuard`

## ActiveContext

Decoupled from auth provider (Better-Auth). Stores which org/publisher the user is currently acting as in `ActiveContext` table. Provides immediate context changes, easy to query/validate. No first-membership-wins — all context explicit.

## Auth Guards (applied globally in NestJS)

- `AuthGuard` (global) — validates session, sets user from ActiveContext
- `ActorTypeGuard` — enforces `@ActorType("CUSTOMER"|"PUBLISHER"|"STAFF")`
- `MemberRolesGuard` — enforces `@MemberRoles("OWNER"|"MEMBER"|"PUBLISHER_OWNER"|"PUBLISHER_MEMBER")`
- `StaffRolesGuard` — enforces `@StaffRoles("SUPER_ADMIN"|"OPERATIONS"|"FINANCE")`
- `OrderOwnershipGuard` — validates resource orgId/publisherId matches user context
- `@Public()` — skips AuthGuard

## AuthGuard Caching

30s per-instance TTL cache (`common/auth-context-cache.ts`, 10K-entry cap). Session still verified every request. Explicit invalidation on context switch, membership invite/remove, role changes. `PermissionsGuard` (decrypt) deliberately uncached.

## Key Models

- `User`, `Session`, `Account`, `Verification` — Better-Auth managed
- `ActiveContext` — session context management
- `Organization` — tenant container for CUSTOMER users
- `Publisher` — tenant container for PUBLISHER users
- `Membership` — CUSTOMER org membership (OWNER/MEMBER)
- `PublisherMembership` — PUBLISHER membership
- `StaffMembership` — STAFF membership with explicit `permissions` JSON field for sensitive permissions (e.g., `FINANCIAL_DATA_DECRYPT`)
- `ApiKey`, `Team`

## Key Files

- `apps/api/src/modules/active-context/`
- `apps/api/src/modules/auth/` — guards, decorators, module
- `apps/api/src/modules/identity/` — user/org membership management
- `apps/api/src/common/guards/`
- `apps/api/src/common/decorators/`
- `apps/api/src/common/auth-context-cache.ts`
- `packages/auth/` — Better-Auth config
