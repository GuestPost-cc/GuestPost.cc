---
note_type: domain-memory
domain: identity-auth
project: guestpost-platform
updated: 2026-07-10
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

## Frontend Auth Entry Points

- `apps/portal/src/app/page.tsx` is the CUSTOMER portal login/signup route. It keeps the existing auth flow through `@guestpost/auth/client`, hydrates the API bearer token with `setToken`, validates `session.user.userType === "CUSTOMER"`, and redirects to the safe `returnTo` or `/dashboard`.
- `apps/publisher/src/app/page.tsx` is the PUBLISHER portal login/signup route. It preserves the publisher conversion flow through `/api/v1/identity/become-publisher`, validates `session.user.userType === "PUBLISHER"`, and redirects to the safe `returnTo` or `/dashboard`.
- Both routes use shared `@guestpost/ui` auth presentation primitives (`AuthLayout`, `AuthCard`, `AuthProviders`, `LoginForm`, `SignupForm`) with app-specific marketing copy and submit labels.

## Key Files

- `apps/api/src/modules/active-context/`
- `apps/api/src/modules/auth/` — guards, decorators, module
- `apps/api/src/modules/identity/` — user/org membership management
- `apps/api/src/common/guards/`
- `apps/api/src/common/decorators/`
- `apps/api/src/common/auth-context-cache.ts`
- `packages/auth/` — Better-Auth config
- `packages/ui/src/components/auth-layout.tsx` — shared split-screen auth layout used by app login/reset flows
- `packages/ui/src/components/auth-card.tsx` — shared auth card shell
- `packages/ui/src/components/login-form.tsx` and `packages/ui/src/components/signup-form.tsx` — shared email/password auth forms
