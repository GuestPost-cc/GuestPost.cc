# PART 4A — Multi-Tenant & Organization Context Audit

## Current Authentication Flow

```
User Login
  │
  ▼
Better-Auth (packages/auth)
  ├─ Handles OAuth, email/password, session creation
  ├─ Creates Session record in DB (id, expiresAt, token, userId)
  └─ Stores session token in HTTP-only cookie
  │
  ▼
Request → AuthGuard (apps/api/src/modules/auth/auth.guard.ts:14-80)
  ├─ Reads session cookie from request headers
  ├─ Calls auth.api.getSession({ headers }) → Better-Auth validates session
  ├─ Fetches User from DB (if not found → UnauthorizedException)
  ├─ Checks user.banned → 403 if banned
  │
  ├─ IF userType === "CUSTOMER":
  │     membership = prisma.membership.findFirst({
  │       where: { userId: user.id },
  │       orderBy: { createdAt: "asc" }   ← FIRST MEMBERSHIP WINS
  │     })
  │     organizationId = membership.organizationId
  │     customerRole = membership.role
  │
  ├─ IF userType === "PUBLISHER":
  │     pubMembership = prisma.publisherMembership.findFirst({
  │       where: { userId: user.id },
  │       include: { publisher: true },
  │       orderBy: { createdAt: "asc" }   ← FIRST MEMBERSHIP WINS
  │     })
  │     publisherId = pubMembership.publisherId
  │     publisherRole = pubMembership.role
  │     organizationId = pubMembership.publisher.organizationId
  │
  ├─ IF userType === "STAFF":
  │     staffMembership = prisma.staffMembership.findUnique({
  │       where: { userId: user.id }
  │     })
  │     staffRole = staffMembership.role
  │     organizationId = null  ← STAFF HAS NO ORG CONTEXT
  │
  ▼
request.user = { ...user, organizationId, customerRole, publisherId, ... }
request.session = session.session
  │
  ▼
  ActorTypeGuard (actor-type.guard.ts:12-26)
  ├─ Checks user.userType matches decorator's required types
  └─ Ex: @ActorType("CUSTOMER") blocks PUBLISHER and STAFF
  │
  ▼
  MemberRolesGuard or StaffRolesGuard
  ├─ MemberRolesGuard: checks customerRole/publisherRole/staffRole
  ├─ StaffRolesGuard: checks user.staffRole ∈ requiredRoles
  └─ Ex: @MemberRoles("OWNER") blocks MEMBER
  │
  ▼
  OrderOwnershipGuard (order-ownership.guard.ts:15-46)
  ├─ Fetches order by :id
  ├─ CUSTOMER: validates order.organizationId === user.organizationId
  ├─ PUBLISHER: validates order.website.publisherId === user.publisherId
  └─ STAFF: always passes
  │
  ▼
  Service Layer
  ├─ Most services filter by user.organizationId (from AuthGuard)
  └─ Wallet ownership is validated inline via BillingService
```

---

## Organization Isolation Diagram

```
                    ┌─────────────────────────────────────┐
                    │              User A                  │
                    │         (userType: CUSTOMER)         │
                    └──────────┬──────────────────────────┘
                               │
              ┌────────────────┼────────────────────┐
              ▼                ▼                     ▼
     ┌────────────────┐ ┌──────────────────┐  ┌──────────────┐
     │  Membership 1  │ │  Membership 2    │  │ Membership 3 │
     │  Org: Acme Inc │ │  Org: Beta Corp  │  │ Org: Gamma   │
     │  Role: OWNER   │ │  Role: MEMBER    │  │ Role: OWNER  │
     │  created: Jan   │ │  created: Feb    │  │ created: Mar │
     └────────────────┘ └──────────────────┘  └──────────────┘
               │                  │                    │
               │    AuthGuard picks FIRST (oldest)     │
               │                  │                    │
               ▼                  ✗                    ✗
     ┌──────────────────┐
     │  user.orgId =    │   ← NEVER changes per session
     │  Acme Inc ID     │      No switching mechanism
     └──────────────────┘
               │
               ▼
     ┌─────────────────────────────────────────────────────┐
     │  All API requests filter by user.organizationId     │
     │  = Acme Inc                                         │
     │                                                     │
     │  • listOrders → WHERE org = Acme Inc                │
     │  • getWallet(orgId=Acme)                             │
     │  • createOrder → orgId = Acme                       │
     │  • ...                                               │
     └─────────────────────────────────────────────────────┘

     RESULT: User A CANNOT access Beta Corp or Gamma data
     through the API. They would need to log out and back in,
     hoping the findFirst picks a different membership
     (but it won't — orderBy: "asc" always picks the oldest).
```

---

## Publisher Isolation Diagram

```
                    ┌──────────────────────────────────────┐
                    │              User B                  │
                    │        (userType: PUBLISHER)          │
                    └──────────┬───────────────────────────┘
                               │
              ┌────────────────┼─────────────────────┐
              ▼                ▼                      ▼
     ┌──────────────────┐ ┌──────────────────┐ ┌──────────────┐
     │ PublisherMembership│ │ PublisherMembership│ │ Publisher... │
     │ Publisher: Pub1  │ │ Publisher: Pub2  │ │              │
     │ Role: OWNER      │ │ Role: MEMBER     │ │              │
     │ created: Jan     │ │ created: Feb     │ │              │
     └──────────────────┘ └──────────────────┘ └──────────────┘
               │                  │                    │
               │    AuthGuard picks FIRST (oldest)     │
               ▼                  ✗                    ✗
     ┌──────────────────┐
     │  user.pubId =    │   ← NEVER changes
     │  Pub1 ID         │
     │  user.orgId =    │
     │  Pub1.orgId      │   ← Publisher's org, not user's org membership!
     └──────────────────┘
               │
               ▼
     ┌─────────────────────────────────────────────────────┐
     │  All publisher operations scoped to Pub1            │
     │  • OrderOwnershipGuard → pub1.orders only           │
     │  • getBalance(pub1) → only Pub1's balance            │
     │  • requestWithdrawal(pub1)                            │
     │  • ...                                               │
     └─────────────────────────────────────────────────────┘

     NOTE: Publisher's organizationId resolves from Publisher.organizationId
     (the org the publisher entity belongs to), NOT from the user's
     Customer-style memberships. This is a different data model path.
```

---

## Staff Access Diagram

```
                    ┌───────────────────────────────────┐
                    │            User C                 │
                    │       (userType: STAFF)           │
                    └──────────┬────────────────────────┘
                               │
                               ▼
                  ┌─────────────────────────┐
                  │  StaffMembership        │
                  │  Role: SUPER_ADMIN      │
                  │  userId: @unique         │ ← One per user
                  └─────────────────────────┘
                               │
                               ▼
                  ┌─────────────────────────┐
                  │  user.staffRole =        │
                  │  SUPER_ADMIN             │
                  │  user.organizationId =   │
                  │  null                    │ ← NO ORG CONTEXT
                  └─────────────────────────┘
                               │
                    ┌──────────┴──────────────┐
                    ▼                         ▼
     ┌──────────────────────┐   ┌──────────────────────────┐
     │ StaffRolesGuard      │   │ Admin Controller          │
     │ Checks user.staffRole│   │ Uses SettlementsService    │
     │ ∈ requiredRoles      │   │ with orgId = undefined     │
     │ Ex: @StaffRoles(     │   │ (list ALL settlements)     │
     │   "SUPER_ADMIN",     │   │                            │
     │   "FINANCE")         │   │ Manual verify/refund       │
     └──────────────────────┘   │ methods use order.orgId    │
                                │ from DB, not user.orgId    │
                                └──────────────────────────┘

     STRENGTH: Staff have no hard orgId constraint — good for cross-org admin
     RISK: user.organizationId = null means wallet lookups
           via BillingService.getWallet(null, userId) pick up
           wallets WHERE organizationId IS NULL — which may be
           old-format wallets or edge cases
```

---

## Wallet Ownership Flow

```
billing.controller.ts:14-17
  GET /billing/wallet
  └─ calls billing.getWallet(user.organizationId, user.id)

billing.service.ts:140-160
  getWallet(organizationId, userId):
    where = organizationId
      ? { organizationId }
      : { userId }
    ├─ Finds wallet by orgId (for CUSTOMER)
    └─ Finds wallet by userId (fallback for STAFF, edge-case CUSTOMER)

  deposit/withdraw/reserve/payFromReserved/refund:
    All methods validate:
      owned = (
        (wallet.organizationId && wallet.organizationId === user.organizationId)
        || (!wallet.organizationId && wallet.userId === user.id)
      )
    ├─ Organization-owned wallet: checks orgId matches user.orgId
    └─ User-owned wallet: checks userId matches

PROBLEM:
  ┌──────────────────────────────────────────────────────────┐
  │ 1. user.organizationId is the FIRST MEMBERSHIP           │
  │    → Multi-org user can only access one org's wallet     │
  │                                                           │
  │ 2. STAFF user.organizationId = null                       │
  │    → createCheckoutSession compares null with             │
  │      wallet.organizationId → ForbiddenException           │
  │    → Staff CANNOT deposit to org wallets (maybe desired?) │
  │                                                           │
  │ 3. Wallet WHERE clause uses organizationId, not userId     │
  │    getWallet(orgId) finds org by orgId                     │
  │    → What if orgA user tries walletId belonging to orgB?  │
  │      deposit() validates wallet orgId === user orgId      │
  │      → ForbiddenException — correct, but only if user     │
  │        belongs to that org (which AuthGuard may not know) │
  └──────────────────────────────────────────────────────────┘
```

---

## Answers

### 1. How is activeOrganizationId determined?

**File:** `apps/api/src/modules/auth/auth.guard.ts:42-44`

```typescript
const membership = await prisma.membership.findFirst({
  where: { userId: user.id },
  orderBy: { createdAt: "asc" },
})
organizationId = membership?.organizationId ?? null
```

It uses `findFirst` ordered by `createdAt: "asc"` — this is the **first membership ever created** (oldest). There is no user-selected active organization, no session switching, no header-based override. Once set, `organizationId` is fixed for the duration of the session.

For PUBLISHER users, `organizationId = publisher.organizationId` (the publisher entity's owning org), not from `Membership`.

For STAFF users, `organizationId = null`.

**Assessment: HIGH** — No multi-org support. A user who belongs to Org A (created Jan) and Org B (created Feb) is permanently locked to Org A.

### 2. Can a user belong to multiple organizations?

**Schema:** `packages/database/prisma/schema.prisma` — `Membership` model

```prisma
@@unique([userId, organizationId])
```

Yes — the composite unique constraint allows one membership per (user, org) pair, but does not prevent multiple rows for the same user across orgs. The `IdentityService.listOrganizations(userId)` returns all orgs a user belongs to.

**Answer:** Yes, a user CAN belong to multiple organizations.

### 3. Can a user switch organizations?

**No.** There is no session-switching mechanism, no endpoint, no header, no query parameter. The `identity` module has no `POST /switch-organization` or similar endpoint. The `AuthGuard` recomputes `organizationId` on every request but always with `findFirst({ orderBy: { createdAt: "asc" } })`.

A user who legitimately belongs to two organizations (e.g., owns Org A and is a member of Org B) must log out and back in, hoping the session creates a different membership resolution — but it won't, because the oldest membership is always picked.

**Assessment: CRITICAL** — Makes the product non-functional for multi-org users.

### 4. Is organization context stored in session/JWT?

**No.** The session is managed entirely by Better-Auth (`@guestpost/auth`). The codebase does not store or read `organizationId` from the session cookie or JWT claims. Every request fetches the user from DB, then queries membership tables to derive `organizationId`.

The `request.session` object (set at `auth.guard.ts:78`) is the raw Better-Auth session — it contains no organization claims.

**Assessment: MEDIUM** — No session storage means every request pays 2-3 extra DB queries, but the correctness concern is that `organizationId` cannot survive session refresh.

### 5. Is "first membership wins" still present?

**Yes, at `auth.guard.ts:43`:**

```typescript
orderBy: { createdAt: "asc" }
```

This is the **first-ever** membership for this user (ascending = oldest first). Same pattern at line 57 for publisher memberships.

**Assessment: CRITICAL** — See #1 and #3 above.

### 6. How are publisher memberships resolved?

**File:** `apps/api/src/modules/auth/auth.guard.ts:53-61`

```typescript
const pubMembership = await prisma.publisherMembership.findFirst({
  where: { userId: user.id },
  include: { publisher: true },
  orderBy: { createdAt: "asc" },
})
publisherId = pubMembership?.publisherId ?? null
publisherRole = pubMembership?.role ?? null
organizationId = pubMembership?.publisher?.organizationId ?? null
```

Same `findFirst({ orderBy: { createdAt: "asc" } })` pattern — first publisher membership wins.

**Critical detail:** The `organizationId` for a PUBLISHER user comes from `Publisher.organizationId` (the organization that owns the publisher entity), NOT from the user's `Membership` rows. This means:
- A publisher user with `Membership` in Org A and `PublisherMembership` in Pub1 (owned by Org B) will have `organizationId = Org B` (from publisher), not Org A.
- When `OrderOwnershipGuard` checks `order.organizationId !== user.organizationId` for a PUBLISHER user, it checks against the publisher's org — but the guard checks `user.userType === "CUSTOMER"` only for org validation, and falls through to "return true" for PUBLISHER type. So the publisher path only validates `publisherId`, not `organizationId`.

**Assessment: HIGH** — A publisher who belongs to multiple publishers can only act as the first one created.

### 7. How are staff memberships resolved?

**File:** `apps/api/src/modules/auth/auth.guard.ts:64-67`

```typescript
const staffMembership = await prisma.staffMembership.findUnique({
  where: { userId: user.id },
})
staffRole = staffMembership?.role ?? null
```

`StaffMembership.userId` is `@unique` in the schema — a user can have at most one staff membership. The `findUnique` is unambiguous.

**Assessment: OK** — Staff resolution is correct.

### 8. Can a user access resources from another organization?

**Short answer:** No — but the reason is the same design flaw working "in reverse."

A user who belongs to Org A (first membership) CANNOT access Org B's data because:
- `user.organizationId` = Org A
- All service filters use `{ organizationId: user.organizationId }` or `findFirst({ where: { organizationId: user.organizationId } })`
- `OrderOwnershipGuard` compares `order.organizationId !== user.organizationId`

**But can a user from Org A access Org B's data if they know the resource ID?**

Yes — several services have insufficient secondary validation:

| Attack Vector | File | Risk |
|---|---|---|
| `GET /orders/:id` with known Org B order ID | `orders.controller.ts` + `OrderOwnershipGuard` | **LOW** — OrderOwnershipGuard validates orgId |
| `GET /settlements/:id` with known settlement ID | `settlements.controller.ts` | **HIGH** — SettlementsController has NO ownership guard, only queries by ID |
| `GET /admin/settlements/:id` | `admin.controller.ts` | **LOW** — StaffRolesGuard |
| `GET /billing/wallet` with missing orgId | `billing.controller.ts:15-17` | **MEDIUM** — Falls back to userId wallet if orgId is null |
| Webhook endpoints | `billing.controller.ts:33-44` | **LOW** — Public endpoint, no user context |
| `POST /settlements/:id/customer-approve` | `settlements.controller.ts:12-14` | **MEDIUM** — Validates org within customerApprove method |

**Specific vulnerability:** SettlementsController endpoints at `settlements.controller.ts:12-14, 19-21` have no guard decorators (`@ActorType`, `@MemberRoles`, `@UseGuards(OrderOwnershipGuard)`). The `customerApprove` method validates org internally, but this is after initial request processing.

### 9. Can a user access another organization's wallet?

**File:** `apps/api/src/modules/billing/billing.service.ts`

All wallet mutation methods (`deposit`, `withdraw`, `reserve`, `payFromReserved`, `refund`) validate:

```typescript
const owned = (
  (wallet.organizationId && wallet.organizationId === user.organizationId) ||
  (!wallet.organizationId && wallet.userId === user.id)
)
```

This validation is correct for the **single-org case**, but for multi-org users:
- User belongs to Org A (first) and Org B
- `user.organizationId` = Org A
- User knows Org B's `walletId`
- POST `/billing/wallet/:id/deposit` with Org B's wallet ID
- `deposit()` checks `wallet.organizationId === user.organizationId` → Org B !== Org A → `ForbiddenException`

**Assessment: MEDIUM** — Correct for single-org. Incorrect for multi-org users who should have access to both orgs' wallets (but can't due to first-membership issue at a higher level).

**Concern:** `getWallet(organizationId, userId)` constructs the WHERE clause:

```typescript
const where = organizationId ? { organizationId } : { userId }
```

For STAFF users (`organizationId = null`), this resolves to `{ userId }`. This may match orphan wallets where `organizationId` was never set. If such a wallet exists (from legacy data), a STAFF user could potentially access it.

### 10. Can a user access another publisher's orders?

**File:** `apps/api/src/modules/orders/orders.controller.ts` + `order-ownership.guard.ts`

For PUBLISHER users:

```typescript
// order-ownership.guard.ts:38-42
if (user.userType === "PUBLISHER") {
  if (order.website?.publisherId !== user.publisherId) {
    throw new ForbiddenException("Order is not assigned to your publisher account")
  }
  return true
}
```

The guard fetches the order by ID and checks `order.website.publisherId`. The `user.publisherId` comes from AuthGuard's `findFirst` — first publisher membership.

A publisher who belongs to multiple publishers can only discover/access orders for the first publisher. A publisher who knows another publisher's order ID will get 403.

**However:** The `OrdersController.list()` endpoint:

```typescript
@Get()
list(@Query("campaignId") campaignId?: string, @CurrentUser() user?: any) {
  if (user.userType === "PUBLISHER") return this.orders.listPublisherOrders(user.publisherId)
  return this.orders.listOrders(user.organizationId, campaignId)
}
```

`listPublisherOrders` queries by `publisherId` (from AuthGuard = first publisher). Correct for single-publisher users.

**Assessment: HIGH** — A publisher who legitimately manages two publisher accounts can only operate the first one.

---

## Cross-Tenant Attack Scenarios

### CRITICAL: No Active Organization Selection

- Any user with multiple org memberships is locked to the first org
- No workaround exists in the API
- Session re-creation does not fix it (always picks the oldest membership)
- Impact: **complete product breakage for multi-org users**

### CRITICAL: SettlementsController Missing Guards

**File:** `apps/api/src/modules/settlements/settlements.controller.ts`

The `customerApprove` and `adminApprove` endpoints have no `@ActorType`, `@MemberRoles`, or `@UseGuards(OrderOwnershipGuard)` decorators. The `customerApprove` method does validate org internally, but `adminApprove` only validates settlement exists and has correct status — it relies on `StaffRolesGuard` at the controller level but the controller has NO guard:

```typescript
@Controller("settlements")
export class SettlementsController {
```

Compare to `admin.controller.ts` which uses `@UseGuards(StaffRolesGuard)` at class level. The SettlementsController has NO class-level guard at all.

### HIGH: No Organization Context in Better-Auth Session

**File:** `apps/api/src/modules/auth/auth.guard.ts`

Organization context is re-derived from DB on every request. There is no way to persist an active org selection. Session tokens contain no org claims. This means:
- No org context survives session refresh
- Every request pays 3+ extra DB queries (user fetch, membership fetch, publisher membership fetch)
- No way to route multi-org users through org-specific URLs

### HIGH: BillingController Wallet Access for STAFF

**File:** `apps/api/src/modules/billing/billing.controller.ts`

`GET /billing/wallet` calls `billing.getWallet(user.organizationId ?? null, user.id)`. For STAFF users, `organizationId = null`, so it finds wallets by `userId` rather than org. If any wallet has `userId` set to a staff user (from some historical operation), the staff user gains access to that wallet's transactions and balance via the transaction list endpoint.

### MEDIUM: OrderOwnershipGuard Bypass via Null User

**File:** `apps/api/src/modules/common/guards/order-ownership.guard.ts`

```typescript
if (!orderId) return true
```

If no `:id` param is present on the route (e.g., `POST /orders` with ID in the body), the guard silently passes. This is by design (non-order-specific endpoints don't need it), but if a future endpoint uses `:id` inconsistently, the guard could be bypassed.

### MEDIUM: Webhook Has No Auth Guard

**File:** `apps/api/src/modules/billing/billing.controller.ts:33-44`

The Stripe webhook endpoint is `@Public()` via AuthGuard's `isPublic` check. This is intentional for Stripe's outbound calls. However, the webhook's `processSuccessfulPayment` creates transactions and updates wallet balances with no org validation — it trusts Stripe's metadata. If Stripe metadata is tampered with (man-in-the-middle or compromised Stripe account), wallet amounts could be manipulated.

### HIGH: No Rate Limit or Brute Force on Org-ID-Guessable Endpoints

No endpoint in the API has rate limiting. Combined with the fact that several endpoints only validate org ownership after fetching the resource, an attacker who knows resource IDs:

1. `GET /settlements/:id` — returns settlement + order data for any org if the ID is valid
2. `GET /orders/:id` — blocked by OrderOwnershipGuard (correct)
3. `GET /billing/transactions` — scoped to user's wallet (correct)

---

## Recommended Redesign

### Phase 1 — Fix Multi-Org Support (CRITICAL)

1. **Add active org selection to the session**

   Either:
   - Store `activeOrganizationId` in Better-Auth session attributes (if supported)
   - Store `activeOrganizationId` in a new `UserSession` table or as a cookie
   - Store `activeOrganizationId` in a custom JWT claim

2. **Add org switching endpoint**

   `POST /identity/switch-organization { organizationId }`
   - Validates the user belongs to the target org
   - Updates `activeOrganizationId` in session/session table
   - Returns new session token or updates current session

3. **Fix AuthGuard resolution**

   Replace `findFirst({ orderBy: { createdAt: "asc" } })` with:
   - Read `activeOrganizationId` from session/session table
   - Validate the user still has a membership for that org
   - Fall back to `findFirst` only if no active org is set

4. **Fix publisher resolution similarly**

   Same pattern: allow publisher account switching, or scope by requested `publisherId` header/param.

### Phase 2 — Add Guards to Bare Endpoints (HIGH)

5. **Add guards to SettlementsController**

   ```
   @Controller("settlements")
   @UseGuards(AuthGuard, ActorTypeGuard)
   export class SettlementsController {
     @Post(":id/customer-approve")
     @ActorType("CUSTOMER")
     @UseGuards(MemberRolesGuard, OrderOwnershipGuard)
     @MemberRoles("OWNER", "MEMBER")
     @RequireOrderOwnership()
     customerApprove(...)
   ```

   The `customerApprove` and `adminApprove` methods validate org internally already, but guards should be explicit for defense-in-depth.

6. **Fix STAFF wallet access**

   Either:
   - Set `organizationId = "system"` for STAFF users (consistent, predictable)
   - Or block STAFF from billing endpoints entirely with `@ActorType("CUSTOMER", "PUBLISHER")`

### Phase 3 — Defensive Overlays (MEDIUM)

7. **Add org context to settlement queries**

   In `SettlementsService.listSettlements`, add a `organizationId` filter when the caller is CUSTOMER type.

8. **Add rate limiting**

   Implement NestJS `@Throttle()` or similar guard on resource-ID-guessable endpoints.

---

## Finding Summary

| ID | Severity | Finding | File:Line |
|---|---|---|---|
| MTA-01 | **CRITICAL** | First-membership-wins for org resolution | `auth.guard.ts:43` |
| MTA-02 | **CRITICAL** | No active org switching mechanism | Entire API |
| MTA-03 | **CRITICAL** | First-membership-wins for publisher resolution | `auth.guard.ts:57` |
| MTA-04 | **CRITICAL** | No publisher switching mechanism | Entire API |
| MTA-05 | **HIGH** | SettlementsController has no class-level guards | `settlements.controller.ts:1` |
| MTA-06 | **HIGH** | STAFF has null orgId, potential wallet cross-access | `auth.guard.ts:69` |
| MTA-07 | **HIGH** | Multi-org user cannot access second org's wallet | `billing.service.ts` (all mutation methods) |
| MTA-08 | **HIGH** | Multi-publisher user cannot access second publisher | `auth.guard.ts:57-61` |
| MTA-09 | **MEDIUM** | Organization context not stored in session/JWT | `auth.guard.ts` (no session writing) |
| MTA-10 | **MEDIUM** | OrderOwnershipGuard bypass when no :id param | `order-ownership.guard.ts:18` |
| MTA-11 | **MEDIUM** | Webhook processes financial transactions with no org context | `billing.controller.ts:33-44` |
| MTA-12 | **MEDIUM** | No rate limiting on resource-ID-guessable endpoints | Entire API |
