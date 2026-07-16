---
note_type: domain-memory
domain: identity-auth
project: guestpost-platform
updated: 2026-07-17
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

## Mutation Security (2026-07-16)

- `BETTER_AUTH_SECRET` is mandatory; the guard no longer has a fallback signing secret.
- State-changing requests with an `Origin` or `Referer` must match the configured CORS-origin allowlist.
- Email verification is required for state-changing operations by CUSTOMER, PUBLISHER, and STAFF actors. Read routes, sign-out, and verification/resend paths remain exempt so a user can recover access.
- Session rotation creates the replacement session and deletes the old one in one transaction.

## Key Models

- `User`, `Session`, `Account`, `Verification` — Better-Auth managed
- `ActiveContext` — session context management
- `Organization` — tenant container for CUSTOMER users
- `Publisher` — tenant container for PUBLISHER users
- `Membership` — CUSTOMER org membership (OWNER/MEMBER)
- `PublisherMembership` — PUBLISHER membership
- `StaffMembership` — STAFF membership with explicit `permissions` JSON field for sensitive permissions (e.g., `FINANCIAL_DATA_DECRYPT`)
- `ApiKey`, `Team`

## Staff RBAC Contract (2026-07-17)

- `SUPER_ADMIN` is the governance and break-glass role. Global Users,
  Organizations, staff-role management, Operations roster, audit logs, and
  cross-staff fulfillment assignment are Super Admin-only.
- `OPERATIONS` owns platform inventory and fulfillment. It has no global Users,
  Organizations, Publishers, Operations roster, or Finance directory access.
  Platform-site reads and mutations are scoped to `managedByUserId`; fulfillment
  reads are scoped to self-assigned or unassigned claimable platform orders.
- `FINANCE` has no global Users or customer Organizations access. It can read
  Publishers and owns settlements, withdrawals, payouts, revenue,
  reconciliation, publisher tier, and platform-fee workflows.
- Work-item responses may include the minimum customer, organization,
  publisher, or assignee context needed for an authorized order, dispute,
  cancellation, ticket, settlement, or withdrawal. This does not grant a
  searchable global directory.
- Sensitive payout decryption still requires explicit
  `FINANCIAL_DATA_DECRYPT`; Super Admin does not bypass that permission.
- Only Super Admin can create staff credential accounts. The staff form creates
  `SUPER_ADMIN`, `OPERATIONS`, or `FINANCE` users with a Better Auth credential
  account and active `StaffMembership`; it does not create customer or
  publisher tenancy records. Customer and Publisher accounts remain signup
  only and cannot be promoted through the staff role endpoint.
- Self-suspension, self-demotion, removal of the last active Super Admin, and
  deactivation or role change of an Operations member with active fulfillment
  assignments are rejected server-side.
- The complete matrix and implementation rules live in `docs/ADMIN_RBAC.md`.

## Frontend Auth Entry Points

- `apps/portal/src/app/page.tsx` is the CUSTOMER portal login/signup route. It keeps the existing auth flow through `@guestpost/auth/client`, hydrates the API bearer token with `setToken`, validates `session.user.userType === "CUSTOMER"`, and redirects to the safe `returnTo` or `/dashboard`.
- `apps/publisher/src/app/page.tsx` is the PUBLISHER portal login/signup route. It preserves the publisher conversion flow through `/api/v1/identity/become-publisher`, validates `session.user.userType === "PUBLISHER"`, and redirects to the safe `returnTo` or `/dashboard`.
- Both routes use shared `@guestpost/ui` auth presentation primitives (`AuthLayout`, `AuthCard`, `AuthProviders`, `LoginForm`, `SignupForm`) with app-specific marketing copy and submit labels.

## Auth Input Validation (2026-07-16)

- Login, signup, forgot-password, and reset-password forms use shared Zod schemas that reject missing and whitespace-only values, trim name/email input, and enforce explicit length limits.
- `@guestpost/ui` uses a Zod 4-compatible `@hookform/resolvers` release for the shared auth forms; the previous v3 resolver rejected with an uncaught `ZodError` instead of populating React Hook Form field errors.
- CUSTOMER and PUBLISHER email signup requires `termsAccepted: true` and displays a required Terms of Service checkbox. STAFF/admin has no signup flow and therefore no Terms checkbox.
- The Better Auth request hook re-validates email login, email signup, and password-reset requests server-side. Terms acceptance is validated before account creation and then removed as a request-only field before the database adapter runs.
- Auth transport errors map duplicate accounts, invalid email/password lengths, rate limits, and server failures to recoverable user-facing messages; form-level API errors use accessible alert semantics.

## Key Files

- `apps/api/src/modules/active-context/`
- `apps/api/src/modules/auth/` — guards, decorators, module
- `apps/api/src/modules/identity/` — user/org membership management
- `apps/api/src/common/guards/`
- `apps/api/src/common/decorators/`
- `apps/api/src/common/auth-context-cache.ts`
- `packages/auth/` — Better-Auth config
- `packages/auth/src/request-validation.ts` — server-side validation for public email auth endpoints
- `packages/ui/src/components/auth-layout.tsx` — shared split-screen auth layout used by app login/reset flows
- `packages/ui/src/components/auth-card.tsx` — shared auth card shell
- `packages/ui/src/components/login-form.tsx` and `packages/ui/src/components/signup-form.tsx` — shared email/password auth forms
