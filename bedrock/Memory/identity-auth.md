---
note_type: domain-memory
domain: identity-auth
project: guestpost-platform
updated: 2026-07-19
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
- Browser authentication uses one opaque, HttpOnly Better Auth database-session cookie. Browser bearer/session tokens and client-side auth-token storage are not supported.
- State-changing cookie-authenticated API requests require an exact trusted `Origin`, same-site Fetch Metadata, and `X-CSRF-Protection: 1`; Better Auth protects its own routes.
- Email verification is required for state-changing operations by CUSTOMER, PUBLISHER, and STAFF actors. Read routes, sign-out, and verification/resend paths remain exempt so a user can recover access.
- Sessions roll for eight hours with a 30-minute refresh cadence. The API additionally enforces a 24-hour absolute lifetime for CUSTOMER/PUBLISHER sessions and eight hours for STAFF, then deletes the expired row.

## Public Account And OAuth Contract (2026-07-19)

- CUSTOMER and PUBLISHER are immutable, mutually exclusive account types. Signup provisions only the selected tenancy, login rejects the wrong portal before a session is issued, the self-serve publisher conversion endpoint is removed, and admin role mutation cannot cross account types.
- Email and Google login never create accounts. Email and Google signup are explicit flows; Google uses `requestSignUp` only from signup after current Terms acceptance. Implicit Google signup and implicit provider linking are disabled.
- The current Terms version is stored in `LegalAcceptance` with audience, method, timestamp, request ID, IP, and user agent. Both email and Google signup require the current version before user creation.
- Google callback failures return to a controlled error URL and map account collision, wrong-portal, cancelled, expired-state, and disabled-signup cases to safe user-facing messages rather than raw 500s.
- Password recovery uses Better Auth's `request-password-reset` route, a single-use one-hour token, queued email delivery, generic anti-enumeration copy, and revocation of all sessions when the password changes.

## Google OAuth staging configuration (2026-07-19)

- Google Auth Platform project `GestPoustLoginGSC` (`gestpoustlogingsc`) owns
  the web OAuth client used by local development and Render staging.
- Authorized callbacks cover Better Auth login and Google Search Console
  integration for both `http://localhost:4000` and
  `https://api.guestpost.pro.bd`; no JavaScript origins are required.
- Branding points to the GuestPost home, privacy, and terms pages under
  `guestpost.pro.bd` (registered authorized domain `pro.bd`).
- The consent grant is intentionally limited to `openid`, email, profile,
  Search Console read-only, and Analytics read-only scopes.
- A 2026-07-19 rollout initially copied an `.env.example` inline comment into
  Render's `GOOGLE_CLIENT_ID` and a Redis env assignment into
  `GOOGLE_CLIENT_SECRET`, producing Google's `401 invalid_client` response.
  Render and the ignored local development env now contain the exact client ID
  and the previously enabled Google secret. A browser smoke test completed the
  Google callback and returned to the customer dashboard successfully.
- The unused secret created on 2026-07-19 remains enabled but its value is not
  recoverable from Google Cloud. Disable and delete that unused secret after
  explicit cleanup approval; the working secret must remain enabled.

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

- The marketing site has one `/login` and one `/signup`, each with Customer/Publisher tabs. All public signup CTAs route through the website; login, signup, Google OAuth, Terms, forgot-password, and reset-password share the platform auth design.
- `apps/portal/src/app/page.tsx` remains the direct CUSTOMER-only login and `apps/publisher/src/app/page.tsx` remains the direct PUBLISHER-only login. Each has a separate explicit signup page and sends a wrong-account user to the correct dashboard.
- Valid shared sessions route to the account's actual dashboard. Safe `returnTo` paths are relative-only; dashboard layouts redirect unauthenticated users instead of rendering a permanent blank screen.
- Admin keeps its separate login page and STAFF-only audience validation.

## Auth Input Validation (2026-07-16)

- Login, signup, forgot-password, and reset-password forms use shared Zod schemas that reject missing and whitespace-only values, trim name/email input, and enforce explicit length limits.
- `@guestpost/ui` uses a Zod 4-compatible `@hookform/resolvers` release for the shared auth forms; the previous v3 resolver rejected with an uncaught `ZodError` instead of populating React Hook Form field errors.
- CUSTOMER and PUBLISHER email and Google signup require the current Terms version. STAFF/admin has no signup flow and therefore no Terms checkbox.
- The Better Auth request hook re-validates audience, login/signup intent, email auth, OAuth signup consent, and password-reset requests server-side. Request-only consent fields never reach the Better Auth user adapter.
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
