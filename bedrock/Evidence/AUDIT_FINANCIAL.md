# PART 4B — Financial System & Money Flow Audit

## PART 1 — Financial Entity Analysis

| Entity | Purpose | Financial Impact | Criticality |
|--------|---------|-----------------|-------------|
| **Wallet** | Holds org-level customer funds (available + reserved) | Direct — every customer payment flows through wallet | **CRITICAL** |
| **Transaction** | Logs every wallet movement | Audit record — reconstructable ledger | **HIGH** |
| **Settlement** | Tracks payment from order → publisher | Determines how much publisher receives | **CRITICAL** |
| **PublisherBalance** | Holds publisher earnings (withdrawable, pending, lifetime) | Direct — every publisher payout reads this | **CRITICAL** |
| **Withdrawal** | Request to move funds from PublisherBalance to bank | Direct — actual money leaving the system | **CRITICAL** |
| **Order** | Customer order with amount and status | Reference amount for all downstream payments | **HIGH** |
| **OrderItem** | Line items with individual prices | Basis for order total calculation | **MEDIUM** |
| **Campaign** | Groups orders under an org | No direct financial impact | **LOW** |
| **Report** | Generated documents | No direct financial impact | **LOW** |
| **OrderDispute** | Freezes settlement, may trigger refund | Can reverse payments | **HIGH** |

---

## PART 2 — Wallet Architecture Review

### Deposit Flow

```
Stripe Checkout Session Created (billing.service.ts:65)
  ↓
Webhook: checkout.session.completed (billing.service.ts:119)
  ↓
Wallet.availableBalance += amount
  ↓
Transaction created (type: DEPOSIT)
```

### Order Payment Flow (new design)

```
OrderPaymentService.submitPayment (order-payment.service.ts:18-97)
  ↓
billing.reserve(walletId, amount)
  ↓
Wallet.availableBalance -= amount
Wallet.reservedBalance += amount
  ↓
Transaction (type: RESERVATION)
  ↓
Order.status → PENDING_PAYMENT
  │
  ▼
OrderPaymentService.capturePayment (order-payment.service.ts:100-150)
  ↓
billing.payFromReserved(walletId, amount)
  ↓
Wallet.reservedBalance -= amount  (available unchanged)
  ↓
Transaction (type: PURCHASE)
  ↓
Order.status → PAID → SUBMITTED
```

### Refund Flow

```
billing.refund() (billing.service.ts:346-400)
  ↓
Tries to release reserved balance first
  ↓
If insufficient reserved, also credits available
  ↓
Transaction (type: REFUND)
```

### Findings

**1. How balances are stored**
Decimal columns with `version` field for optimistic concurrency:
```prisma
model Wallet {
  availableBalance  Decimal @default(0)
  reservedBalance   Decimal @default(0)
  version           Int     @default(0)
}
```

**2. How balances are updated**
All mutation methods in BillingService use `updateMany({ where: { id, version } })` and check `updated.count === 0` → `ConflictException`. This is **correct** — prevents concurrent overwrites.

Exception: `processSuccessfulPayment` (webhook handler) at line 151-153:
```typescript
await tx.wallet.update({
  where: { id: walletId },
  data: { availableBalance: { increment: amount } },
})
```
This uses `update` (not `updateMany`) with **no version check**. A concurrent webhook event can double-credit the wallet.

**3. Whether transactions are atomic**
Yes — all wallet mutations are inside `prisma.$transaction`. The `reserve`, `payFromReserved`, `refund`, `deposit`, `withdraw` methods all use transactions.

**4. Whether balances can become negative**
`reserve` checks: `if (available < amount) throw BadRequestException` — **correct**.
`payFromReserved` checks: `if (reserved < amount) throw BadRequestException` — **correct**.
`refund` does not decrement balances (only increments) — safe.
`withdraw` checks: `if (available < amount)` — **correct**.

**5. Whether balances can diverge from transaction history**
Every balance mutation creates a Transaction record in the same transaction. In theory, balance = initial + sum(transactions). But there's no periodic reconciliation job to verify this.

### Unique: Concurrent Request Overspend (CRITICAL)

**File:** `billing.service.ts:129-133` (processSuccessfulPayment)

```typescript
const existingTx = await this.prisma.transaction.findFirst({
  where: { reference: session.id },
})
if (existingTx) { return }  // ← Check is OUTSIDE transaction
```

Two concurrent Stripe webhooks for the same session:
1. Both check `existingTx` → both get `null`
2. Both enter the transaction
3. Both `increment availableBalance`
4. Both create Transaction with same `reference`
5. Wallet is credited **twice**

The `Transaction.reference` field has **no unique constraint** (it's `String?` without `@unique`).

**Fix required:**
- Add `@@unique([reference])` on Transaction (where reference is not null)
- OR move the duplicate check INSIDE the transaction
- OR add version-based concurrency to the wallet update in webhook

---

## PART 3 — Transaction Ledger Review

Transaction model serves as: **payment log** + **accounting record** (partial ledger).

### Transaction Coverage Matrix

| Event | Transaction Created? | Type | Reference |
|-------|---------------------|------|-----------|
| Wallet deposit (Stripe webhook) | YES | DEPOSIT | session.id |
| Wallet deposit (manual) | YES | DEPOSIT | provided reference |
| Wallet withdrawal | YES | WITHDRAWAL | idempotencyKey |
| Order reservation | YES | RESERVATION | orderId |
| Order release | YES | RELEASE | orderId |
| Payment capture (reserved→spent) | YES | PURCHASE | orderId |
| Refund | YES | REFUND | `refund-${orderId}` |
| Settlement release to publisher | **NO** | MISSING | — |
| Dispute resolution (refund) | Handled by billing.refund() | REFUND | orderId |
| Failed payment | **NO** | MISSING | — |
| Manual adjustment (admin) | **NO** | MISSING | — |
| Chargeback | **NO** | MISSING | — |

### Missing: Settlement Release Transaction (CRITICAL)

Settlement `releaseFundsInternal` at `settlements.service.ts:239-268`:

```typescript
private async releaseFundsInternal(tx, settlementId, settlement, userId) {
  const balance = await tx.publisherBalance.upsert({
    where: { publisherId: settlement.publisherId },
    create: { publisherId, withdrawableBalance, lifetimeEarnings },
    update: { withdrawableBalance: { increment }, lifetimeEarnings: { increment } },
  })
  await tx.settlement.update({
    where: { id: settlementId },
    data: { status: "RELEASED", settledAt: new Date() },
  })
  await tx.order.update({
    where: { id: settlement.orderId },
    data: { status: "SETTLED" },
  })
```

No Transaction record is created for the settlement release. If the platform needs to reconstruct publisher payouts from transaction history, settlement releases are invisible in the transaction log.

**Fix:** Create a Transaction record with the amount when releaseFundsInternal runs.

---

## PART 4 — Payment Flow Review

### Bypass Payment (MEDIUM)

Can users bypass payment? The new design enforces:
- `submitPayment` requires DRAFT status and sufficient wallet balance
- `capturePayment` requires PENDING_PAYMENT
- Status transitions DRAFT→PENDING_PAYMENT→PAID are system-enforced

**But:** `OrderPaymentService.capturePayment` sets `PAID` then immediately `SUBMITTED`. The `PAID` status is transitional — it exists for less than one transaction. If the capture succeeds but the auto-submit update fails, the order stays in PAID with funds captured. This is handled by the transaction atomicity, so it's safe.

### Pay Less Than Order Total (HIGH)

`submitPayment` at `order-payment.service.ts:36-66` recalculates total from server-side listing/service prices:

```typescript
for (const item of items) {
  if (item.websiteId) {
    const listing = await tx.marketplaceListing.findFirst({
      where: { websiteId: item.websiteId, status: "APPROVED" },
    })
    const serverPrice = Number(listing.price)
    if (Number(item.price) !== serverPrice) {
      await tx.orderItem.update({ where: { id: item.id }, data: { price: serverPrice } })
      verifiedTotal += serverPrice
    }
  }
}
```

**Vulnerability:** The listing price is fetched at SUBMIT time, not at order creation time. If a listing price is lowered between order creation and payment, the customer pays the lower price. If the price is raised, the customer pays the original. This is a **price drift issue** but not an exploit per se — the server always picks the current price, not the price at order creation.

**However:** A malicious publisher could:
1. Set listing price to $50
2. Customer creates order (order total = $50)
3. Publisher raises price to $500
4. Customer submits payment
5. Server re-reads listing price → $500
6. Customer is charged $500 unexpectedly

The price re-read means the customer never pays less than the current price, but they could pay MORE than expected. This is a pricing integrity issue.

### Pricing Manipulation (CRITICAL)

`submitPayment` re-reads listing price but does NOT update the `order.amount` correctly:

```typescript
if (verifiedTotal !== amount) {
  await tx.order.update({ where: { id: orderId }, data: { amount: verifiedTotal } })
}
```

Then:
```typescript
const freshWallet = await tx.wallet.findUniqueOrThrow({ where: { id: wallet.id } })
if (Number(freshWallet.availableBalance) < (verifiedTotal || amount)) {
  throw new BadRequestException("Insufficient available balance after price verification")
}

await this.billing.reserve(wallet.id, verifiedTotal || amount, orderId, { ... })
```

The amount reserved is `verifiedTotal || amount` — if `verifiedTotal` is 0 (all items at zero price? possible via price manipulation) it falls back to `amount` (original). But the `verifiedTotal` calculation is:

```typescript
let verifiedTotal = 0
for (const item of items) {
  // If listing exists, verifiedTotal += serverPrice
  // If no listing found → BadRequestException "Listing no longer available"
}
```

If the marketplace listing is deleted between order creation and payment, `submitPayment` throws. Good — but what if the listing was changed to a minimal price? The price sent to `reserve` is the current server price, not the original. This should not be exploitable downward because the server always uses the current price.

But wait — what if an item has no `websiteId`? Then it uses `service.findFirst`. If the service price is 0 or the service is deactivated, the behavior is:
- Service not found → BadRequestException (correct)
- Service price is 0 → verifiedTotal stays 0 for that item (problematic)

### Duplicate Payment / Replay (HIGH)

`submitPayment` at `order-payment.service.ts:22`:
```typescript
if (order.status !== "DRAFT") throw new BadRequestException("Order must be DRAFT to submit payment")
```

After `submitPayment`, status changes to `PENDING_PAYMENT`. A second call is rejected. **Correct.**

After `capturePayment`, status changes to `PAID` then `SUBMITTED`. A second capture call is rejected because status check at line 104:
```typescript
if (order.status !== "PENDING_PAYMENT") throw new BadRequestException(...)
```

**Correct.** Status-based replay protection is in place.

---

## PART 5 — Stripe Security Audit

### Checkout Session (billing.service.ts:47-79)

```typescript
async createCheckoutSession(walletId: string, amount: number, user: any) {
  const wallet = await this.prisma.wallet.findUnique({ where: { id: walletId } })
  if (!wallet) throw new NotFoundException("Wallet not found")
  const owned = (wallet.organizationId && wallet.organizationId === user.organizationId) || ...
  if (!owned) throw new ForbiddenException("Wallet does not belong to this account")
  ...
  metadata: { walletId, userId: user.id, amount: amount.toString(), organizationId }
```

**Findings:**
- Wallet ownership validated before session creation ✓
- Amount is passed to Stripe AND stored in metadata ✓
- But amount is NOT validated against any limit, minimum, or reference

### Webhook (billing.service.ts:101-131)

```typescript
async handleWebhook(signature: string, payload: Buffer) {
  if (!this.stripe || !process.env.STRIPE_WEBHOOK_SECRET) {
    if (!isDev) { throw new BadRequestException("Webhook not configured") }
    // Dev mode: accept dummy payload
    // ...
  }
  event = this.stripe.webhooks.constructEvent(payload, signature, process.env.STRIPE_WEBHOOK_SECRET)
  // ...
}
```

**Findings:**
- Stripe signature validation in production ✓
- Dev mode allows `signature === "dummy"` — accepted for local dev, documented
- Webhook endpoint is NOT behind AuthGuard (public by design) ✓

### Metadata Manipulation

Stripe webhook reads:
```typescript
const walletId = session.metadata?.walletId || session.client_reference_id
const amount = parseInt(session.metadata?.amount || "0", 10)
```

**Vulnerability:** The metadata comes from Stripe's session object which, in a properly configured Stripe integration, is set by the server at session creation. If an attacker can forge a webhook call with a valid Stripe signature but manipulated checkout session:
- `walletId` could be any wallet ID
- `amount` could be any positive number

**Mitigation:** Stripe's webhook signatures prevent forgery — the signature covers the entire payload, so metadata cannot be tampered with after session creation. And session metadata was set server-side in `createCheckoutSession`.

**However:** The `processSuccessfulPayment` method does NOT validate that the wallet matches the user who created the session. It just looks up `metadata.walletId` and credits it. This is acceptable because the only way to trigger this is through a legitimate Stripe webhook, and the checkout session's metadata was set by the server.

**No re-validation of wallet ownership on webhook receipt.**

### Missing: Amount Validation Post-Webhook (MEDIUM)

The `processSuccessfulPayment` doesn't verify that `amount` from metadata is positive, reasonable, or matches any expected payment. A bug in Stripe metadata could pass `amount: "0"` or `amount: "-100"`. The `parseInt` on `"0"` would result in `0`, and the function early-returns `if (!amount)`. Negative amounts: `parseInt("-100") = -100`, which would **decrease** the wallet balance:

```typescript
data: { availableBalance: { increment: amount } },  // amount = -100 → decrement!
```

**Fix:** Validate `amount > 0` before incrementing.

---

## PART 6 — Settlement Audit

### Settlement Release Duplicate (CRITICAL)

**File:** `settlements.service.ts:239-268` (`releaseFundsInternal`)

```typescript
private async releaseFundsInternal(tx, settlementId, settlement, userId) {
  ...
  await tx.settlement.update({
    where: { id: settlementId },
    data: { status: "RELEASED", settledAt: new Date() },
  })
  ...
}
```

The method does NOT check if the settlement is already `RELEASED`. If called twice (via concurrent admin clicks or race condition), the wallet credits and publisher balance increments happen twice.

**Exploit scenario:**
1. Settlement is `ADMIN_APPROVED`
2. `adminApprove` calls `releaseFundsInternal` → updates to RELEASED
3. Concurrent call (or retry) also calls `releaseFundsInternal`
4. Both succeed — publisher is paid twice

**The `releaseFundsInternal` is only called from:**
- `adminApprove` (line 186) — after setting ADMIN_APPROVED
- `forceApprove` (line 224) — after setting ADMIN_APPROVED

But the check happens: `settlement.status !== "CUSTOMER_APPROVED"` at line 165 protects `adminApprove`. However, this check is on the ORIGINAL settlement fetched before the transaction — two concurrent calls to `adminApprove` could both pass this check.

**Fix:**
- Add status check inside the transaction before updating to RELEASED
- Add version-based concurrency to Settlement model
- Use `updateMany({ where: { id, status: "ADMIN_APPROVED" } })` instead of plain `update`

### Duplicate Approval (HIGH)

SettlementApproval model allows multiple approvals of the same type:

```prisma
model SettlementApproval {
  id           String   @id @default(cuid())
  settlementId String
  type         String   // "CUSTOMER" | "ADMIN"
  approvedBy   String
  ...
}
```

There is **no unique constraint** preventing duplicate approvals of the same type for the same settlement. A customer could call `customerApprove` multiple times.

**Mitigation:** The `customerApprove` method checks `settlement.status !== "PENDING" && settlement.status !== "UNDER_REVIEW"` — so after first approval (status → CUSTOMER_APPROVED), subsequent calls are rejected. This works for sequential calls but not concurrent.

**Fix:** Add `@@unique([settlementId, type])` on SettlementApproval.

### ForceApprove Bypasses Controls (HIGH)

`forceApprove` at `settlements.service.ts:196-229`:

```typescript
const targetStatus = settlement.status === "CUSTOMER_APPROVED" ? "ADMIN_APPROVED" : "CUSTOMER_APPROVED"
await tx.settlement.update({ where: { id }, data: { status: targetStatus } })
```

If settlement is `PENDING`, `targetStatus = "CUSTOMER_APPROVED"`. Then:
```typescript
if (targetStatus === "ADMIN_APPROVED") {
  await this.releaseFundsInternal(...)
}
```

Since targetStatus is "CUSTOMER_APPROVED" (not "ADMIN_APPROVED"), it does NOT auto-release. The settlement stays in CUSTOMER_APPROVED. This seems correct for forceApprove from PENDING — but the method is confusing. It should either complete both approvals or require the caller to invoke it twice.

**The bigger issue:** `forceApprove` skips the `CUSTOMER_APPROVED` flow entirely when status starts as `PENDING`:
- Normal flow: PENDING → CUSTOMER_APPROVED → ADMIN_APPROVED → RELEASED
- forceApprove: PENDING → CUSTOMER_APPROVED (stops, no release)
- forceApprove again: CUSTOMER_APPROVED → ADMIN_APPROVED → RELEASED

This effectively requires two calls to forceApprove, which is bad UX. But functionally correct.

### Missing: Settlement-Order Amount Mismatch Check

`createSettlement` doesn't verify the order amount matches the settlement amount. It recalculates from `order.amount`, which is correct. But the `releaseFundsInternal` publishes `settlement.publisherAmount` without checking it against the original order amount.

---

## PART 7 — Publisher Balance Audit

### Balance Update Pattern

PublisherBalance fields:
- `withdrawableBalance` — can be withdrawn
- `pendingBalance` — currently always 0 (unused in release flow)
- `lifetimeEarnings` — cumulative sum of all settlements
- `lifetimePaid` — currently always 0 (unused)

### Release Flow

`releaseFundsInternal` at `settlements.service.ts:241-251`:
```typescript
const balance = await tx.publisherBalance.upsert({
  where: { publisherId: settlement.publisherId },
  create: {
    publisherId,
    pendingBalance: 0,
    approvedBalance: 0,
    withdrawableBalance: Number(settlement.publisherAmount),
    lifetimeEarnings: Number(settlement.publisherAmount),
  },
  update: {
    withdrawableBalance: { increment: Number(settlement.publisherAmount) },
    lifetimeEarnings: { increment: Number(settlement.publisherAmount) },
  },
})
```

**Problems:**
1. **No version-based concurrency** on PublisherBalance — unlike Wallet, there's no `version` field
2. Two concurrent releases to the same publisher could both read the old balance, both increment, causing drift (though the upsert's update is atomic at the DB level with `{ increment: ... }`)
3. No Transaction record created for settlement release (see Part 3)

### Balance Drift Risk (HIGH)

If a settlement release fails after the PublisherBalance update but before the Transaction is created (hypothetical — currently no Transaction is created), the balance is incremented without any audit trail. Recovery would require manual reconciliation.

### Withdrawal Flow

`requestWithdrawal` at `publisher-payouts.service.ts:55-82`:
```typescript
return this.prisma.$transaction(async (tx: any) => {
  const withdrawal = await tx.withdrawal.create({ data: { publisherId, amount, method, status: "PENDING" } })
  await tx.publisherBalance.update({
    where: { publisherId },
    data: { withdrawableBalance: { decrement: amount } },
  })
```

**Problems:**
1. Balance check (`withdrawable < amount`) is OUTSIDE the transaction (line 48-53)
2. No version-based concurrency on PublisherBalance
3. Two concurrent withdrawal requests could both pass the balance check, then both decrement, potentially causing negative balance

**Exploit:**
1. Publisher has $100 withdrawable
2. Two withdrawal requests for $100 arrive simultaneously
3. Both pass `withdrawable < 100` check (both see $100)
4. Both enter the transaction
5. Both decrement by $100
6. Publisher balance becomes -$100

**Fix:** Move balance check INSIDE the transaction, add version-based concurrency.

---

## PART 8 — Withdrawal Security Audit

### Duplicate Withdrawal Prevention (CRITICAL)

`requestWithdrawal` at `publisher-payouts.service.ts:34-82`:
- Balance checked outside transaction
- No idempotency key
- Withdrawal created then balance decremented in same transaction
- No unique constraint to prevent duplicate pending withdrawals

**Exploit:** Two concurrent requests (or one retried request) for the same publisher:
1. Both read balance = $100
2. Both pass `withdrawable < 100`
3. Both create a PENDING withdrawal
4. Both decrement balance by $100
5. Two withdrawals, balance = -$100

### Withdrawal State Machine

```
PENDING → APPROVED → COMPLETED
PENDING → REJECTED
```

`approveWithdrawal` checks status === "PENDING" at start (outside transaction at line 91). Then inside transaction, updates to APPROVED. A concurrent approval of the same withdrawal would see `status !== "PENDING"` and throw. **Correct.**

`rejectWithdrawal` restores balance (line 168-171):
```typescript
await tx.publisherBalance.update({
  where: { publisherId: withdrawal.publisherId },
  data: { withdrawableBalance: { increment: Number(withdrawal.amount) } },
})
```
**Correct** — refunds the decremented balance on rejection.

`markWithdrawalPaid` checks status === "APPROVED" (outside transaction at line 129). This could race, but the consequence is benign (double-marking as COMPLETED doesn't affect balances).

---

## PART 9 — Dispute & Refund Audit

### Dispute → Settlement Interaction

When a dispute is opened (`order-dispute.service.ts:12-62`):
- Order status → DISPUTED
- Dispute record created with `status: "OPEN"`

But the settlement is NOT automatically blocked. The `customerApprove` and `adminApprove` methods check for active disputes:

```typescript
const activeDispute = await this.prisma.orderDispute.findFirst({
  where: { orderId: settlement.orderId, status: { in: ["OPEN", "UNDER_REVIEW"] } },
})
if (activeDispute) throw new BadRequestException("Cannot approve settlement while dispute is active")
```

**Correct** — settlement cannot be approved during active dispute.

### Refund Scenarios

#### Refund after settlement released

`admin.service.ts:74-127` (`refundOrder`):
```typescript
const activeSettlement = await tx.settlement.findFirst({
  where: { orderId, status: { not: "CANCELLED" } },
})
if (activeSettlement && activeSettlement.status !== "RELEASED") {
  await tx.settlement.update({ where: { id: activeSettlement.id }, data: { status: "CANCELLED" } })
}
```

**Vulnerability:** If the settlement IS RELEASED, the refund does NOT reverse the publisher balance increment. The admin refunds the wallet but the publisher keeps the funds.

**Exploit:**
1. Order DELIVERED → settlement auto-created
2. Settlement approved by both sides → RELEASED
3. Publisher paid (PublisherBalance incremented)
4. Admin refunds order (reason: "customer dispute")
5. Wallet gets credited back
6. Publisher keeps the money
7. No automatic clawback from PublisherBalance

**Fix:** When refunding a RELEASED settlement, also decrement the publisher's `withdrawableBalance` and `lifetimeEarnings`.

#### Double Refund Prevention

`billing.refund()` checks at line 362-365:
```typescript
const existingRefund = await tx.transaction.findFirst({
  where: { orderId, type: "REFUND" },
})
if (existingRefund) throw new BadRequestException("Order already refunded")
```

This check is INSIDE the transaction, so concurrent refunds are safe.

**But:** `admin.service.ts:refundOrder` has its OWN duplicate check — it doesn't use `billing.refund()`. It directly manipulates the wallet:
```typescript
await tx.wallet.updateMany({
  where: { id: wallet.id, version: wallet.version },
  data: {
    reservedBalance: { decrement: amount },
    availableBalance: { increment: amount },
    version: { increment: 1 },
  },
})
```

The admin `refundOrder` does NOT create a REFUND Transaction. So if `billing.refund()` is called separately later, its check for `existingRefund` would NOT find one, and the refund would process again.

**Fix:** Admin `refundOrder` should create a REFUND Transaction.

---

## PART 10 — Concurrency & Race Conditions

### Transaction Audit Log

| Method | File:Line | Transaction | Version Check | Duplicate Prevention |
|--------|-----------|-------------|---------------|---------------------|
| BillingService.deposit | billing.service.ts:165-198 | YES | YES (updateMany) | `reference` in transaction |
| BillingService.withdraw | billing.service.ts:201-245 | YES | YES (updateMany) | `idempotencyKey` in transaction |
| BillingService.reserve | billing.service.ts:276-308 | YES | YES (updateMany) | — |
| BillingService.payFromReserved | billing.service.ts:315-348 | YES | YES (updateMany) | — |
| BillingService.release | billing.service.ts:250-273 | YES | YES (updateMany) | — |
| BillingService.refund | billing.service.ts:351-400 | YES | YES (updateMany) | YES (inside tx) |
| BillingService.processSuccessfulPayment | billing.service.ts:140-166 | YES | **NO** | **NO (outside tx)** |
| publisher-payouts.requestWithdrawal | publisher-payouts.service.ts:55-82 | YES | **NO** | **NO** |
| publisher-payouts.approveWithdrawal | publisher-payouts.service.ts:95-121 | YES | — | Status check inside tx |
| publisher-payouts.rejectWithdrawal | publisher-payouts.service.ts:162-193 | YES | **NO** | — |
| SettlementsService.releaseFundsInternal | settlements.service.ts:239-268 | YES | **NO** | **NO** |

### Summary of Race Conditions

| # | Vulnerability | Location | Severity |
|---|--------------|----------|----------|
| RC-1 | Double wallet credit via concurrent webhook | billing.service.ts:129-133 | **CRITICAL** |
| RC-2 | Duplicate withdrawal via concurrent requests | publisher-payouts.service.ts:48-53 | **CRITICAL** |
| RC-3 | Duplicate settlement release | settlements.service.ts:239-268 | **CRITICAL** |
| RC-4 | PublisherBalance has no version field | schema.prisma (PublisherBalance) | **HIGH** |
| RC-5 | Double admin approval for settlement | settlements.service.ts:155-189 | **HIGH** |
| RC-6 | Admin refund doesn't create Transaction | admin.service.ts:109-126 | **HIGH** |

---

## PART 11 — Identity & Ownership Validation

### Wallet Ownership (OK)

BillingService validates on every mutation:
```typescript
const owned = (
  (wallet.organizationId && wallet.organizationId === user.organizationId) ||
  (!wallet.organizationId && wallet.userId === user.id)
)
if (!owned) throw new ForbiddenException(...)
```

With the new ActiveContext from Part 4A, `user.organizationId` is the active org — correct for CUSTOMER. For PUBLISHER, `user.organizationId` could be null — but billing endpoints now require `@ActorType("CUSTOMER")`, so publisher users are blocked from billing endpoints entirely.

### Settlement Ownership (OK)

`customerApprove` validates:
```typescript
if (settlement.order.organizationId !== organizationId) {
  throw new ForbiddenException("Settlement does not belong to your organization")
}
```

`adminApprove` validates staff role via `@StaffRolesGuard`.

### Withdrawal Ownership (OK)

`requestWithdrawal` validates:
```typescript
const membership = await this.prisma.publisherMembership.findFirst({
  where: { userId, publisherId },
})
if (!membership) throw new ForbiddenException("You do not own this publisher account")
```

### Publisher Balance Ownership (OK)

`getBalance` takes `publisherId` from `user.publisherId` (ActiveContext). No direct ID parameter from client — safe.

---

## PART 12 — Webhook Resilience

### Current State

The Stripe webhook handler at `billing.controller.ts:35-47`:
- Parses raw body
- Delegates to `billing.handleWebhook`
- Returns `{ received: true }`

`handleWebhook` at `billing.service.ts:101-131`:
- In production: validates Stripe signature via `constructEvent`
- In dev: accepts dummy signature
- Calls `processSuccessfulPayment`

`processSuccessfulPayment` at `billing.service.ts:133-168`:
- Checks for existing transaction by `session.id`
- Creates transaction + wallet credit

### Idempotency Failure

As analyzed in Part 2: duplicate detection is outside the transaction, and Transaction.reference has no unique constraint. **Webhook replay/duplicate can double-credit.**

### Stripe-Specific Risks

Stripe guarantees: "Webhook endpoints might occasionally receive the same event more than once." The system MUST be idempotent. Currently it is NOT for concurrent delivery.

---

## PART 13 — Accounting Consistency

### Can balances be reconstructed from transactions?

**Wallet:** YES — `availableBalance + reservedBalance = initial + sum(transactions.amount)`. Every wallet mutation creates a Transaction. But:
- The `processSuccessfulPayment` uses `update` (not `updateMany`) without version check
- If double-credited, the balance would differ from sum(transactions) + initial

**PublisherBalance:** NO — settlement releases don't create Transaction records. `withdrawableBalance = sum(settlements.publisherAmount) - sum(withdrawals.amount)` could be derived, but only by joining across tables, not from a single ledger.

### Accounting Integrity Score: **6/10**

Missing:
- No Transaction record for settlement releases
- No Transaction record for admin refunds
- No periodic reconciliation
- No balance snapshots
- No double-entry bookkeeping

---

## PART 14 — Fraud Analysis

| Attack | Impact | Likelihood | Mitigation |
|--------|--------|------------|------------|
| Webhook replay → double wallet credit | Funds created from nothing | **MEDIUM** (race condition, low skill) | Move duplicate check inside tx, add unique constraint |
| Concurrent withdrawal → negative balance | Publisher over-withdraws | **MEDIUM** (race condition) | Move balance check inside tx, add version field |
| Concurrent settlement release → double pay | Publisher paid twice | **LOW** (requires concurrent admin clicks) | Add status check + version field |
| Listing price manipulation | Customer overcharged | **LOW** (requires publisher coordination) | Lock price at order creation time |
| Refund after settlement released | Publisher keeps funds | **HIGH** (intentional by admin or exploit) | Auto-clawback PublisherBalance on refund |
| Fake settlement creation | Publisher gets unearned payout | **LOW** (requires staff role) | StaffRolesGuard on settlement admin endpoints |
| Rejected withdrawal replay | Balance not restored | **MEDIUM** (race condition on rejection) | Already in tx, but no version check |
| Stripe metadata manipulation | Wrong wallet credited | **LOW** (signature prevents tampering) | Already mitigated by Stripe signatures |

---

## PART 15 — Final Report

### CRITICAL FINDINGS

#### CF-1: Concurrent Webhook Double-Credit

**File:** `billing.service.ts:129-133`, `billing.service.ts:140-166`

The duplicate check for Stripe webhook events runs OUTSIDE the database transaction without a unique constraint on `Transaction.reference`. Two concurrent webhook calls for the same checkout session both pass the check, then both create DEPOSIT transactions and both increment the wallet balance.

**Exploit:** Deliver two identical Stripe webhook events simultaneously. Wallet credited twice. Money created from nothing.

**Financial Impact:** Unlimited — each replay creates X dollars from nothing.

**Fix:** Add `@@unique([reference])` on Transaction where reference is not null. Move the duplicate check INSIDE the transaction.

#### CF-2: Concurrent Withdrawal Overspend

**File:** `publisher-payouts.service.ts:48-53`

Balance sufficiency check runs OUTSIDE the transaction. Two concurrent withdrawal requests both see the same balance, both pass, then both decrement.

**Exploit:** Publisher with $100 balance submits two withdrawal requests for $100 simultaneously. Both succeed. Balance becomes -$100.

**Financial Impact:** Publisher can withdraw funds they don't have.

**Fix:** Move balance check INSIDE the transaction. Add version field to PublisherBalance for optimistic concurrency.

#### CF-3: Settlement Release Duplicate

**File:** `settlements.service.ts:239-268`

`releaseFundsInternal` does not check if settlement is already RELEASED before updating. No version-based concurrency on Settlement model. Two concurrent calls both release the same settlement.

**Exploit:** Staff double-clicks "Admin Approve" (or scripted retry). Publisher receives payment twice.

**Financial Impact:** Each double-release pays the publisher 2x the settlement amount.

**Fix:** Add status check inside the transaction: `updateMany({ where: { id, status: "ADMIN_APPROVED" } })` and verify count === 1. Add version field to Settlement.

---

### HIGH FINDINGS

#### HF-1: PublisherBalance Has No Concurrency Control

**File:** `packages/database/prisma/schema.prisma` (PublisherBalance model)

PublisherBalance has no `version` field. All updates use plain `publisherBalance.update()` without optimistic locking. Combined with CF-2, this enables races.

**Fix:** Add `version Int @default(0)` to PublisherBalance. Use `updateMany({ where: { publisherId, version } })` pattern.

#### HF-2: Settlement Approval Duplicate

**File:** `settlements.service.ts:108-120` (`customerApprove`)

SettlementApproval allows multiple approvals of the same type for the same settlement. While the status enforcement prevents sequential duplicates, concurrent calls can create two CUSTOMER_APPROVED approvals.

**Fix:** Add `@@unique([settlementId, type])` on SettlementApproval model.

#### HF-3: No Transaction for Settlement Release

**File:** `settlements.service.ts:239-268`

`releaseFundsInternal` does not create a Transaction record. Publisher payout history cannot be reconstructed from the transaction ledger alone.

**Fix:** Create a `Transaction` record during release.

#### HF-4: Admin Refund Missing Transaction

**File:** `admin.service.ts:109-126`

`refundOrder` manipulates wallet directly without creating a REFUND Transaction. Subsequent `billing.refund()` would not detect the duplicate because its check looks for Transaction type REFUND.

**Fix:** Create a REFUND Transaction in `admin.service.ts:refundOrder`.

#### HF-5: Webhook Wallet Update Without Version Check

**File:** `billing.service.ts:151-153`

`processSuccessfulPayment` uses `wallet.update()` instead of `wallet.updateMany({ where: { version } })`. This loses the optimistic concurrency that protects all other wallet mutations.

**Fix:** Use `updateMany` with version check. Retry on conflict.

#### HF-6: No Amount Validation in Webhook

**File:** `billing.service.ts:150`

`const amount = parseInt(session.metadata?.amount || "0", 10)` — negative amounts would decrement the wallet. No `amount > 0` check.

**Fix:** Add `if (amount <= 0) return` check before processing.

#### HF-7: Refund After Settlement Release Doesn't Claw Back

**File:** `admin.service.ts:91-97`

If settlement is already RELEASED when a refund is issued, the publisher balance is NOT decreased. The customer gets refunded but the publisher keeps the funds.

**Fix:** When refunding a RELEASED settlement, decrement `withdrawableBalance` and `lifetimeEarnings`.

---

### MEDIUM FINDINGS

#### MF-1: Price Drift Between Order Creation and Payment

**File:** `order-payment.service.ts:36-66`

Listing price is re-read at payment submission time, not locked at order creation. If publisher raises price between order and payment, customer pays more.

**Fix:** Lock price in OrderItem at creation time. Do not re-read at payment time.

#### MF-2: OrdersController listPublisherOrders Uses user.publisherId

**File:** `orders.controller.ts:44`

Uses `user.publisherId` (ActiveContext). With the new ActiveContext system, this is now correct.

#### MF-3: No Balance Reconciliation

No system exists to verify that `Wallet.balance == sum(Transaction.amount)` or `PublisherBalance.withdrawable == sum(releases) - sum(withdrawals)`.

**Fix:** Create a scheduled job that reconciles balances against transaction history.

#### MF-4: Webhook Success Response Reveals Implementation

`handleWebhook` returns `{ received: true, dummy: true }` in dev mode. In production, returns `{ received: true }`. No sensitive data leakage, but the `dummy` flag should be stripped in non-dev.

---

### System Verdict: "Would I trust this financial system with real money today?"

**NO.** Not in its current state.

**Rationale:**

The system has three **critical** race conditions that can create or destroy money:

1. A Stripe webhook delivered twice (guaranteed by Stripe's at-least-once delivery) can double-credit a wallet because the idempotency check is outside the transaction and `Transaction.reference` has no unique constraint. **This is the most dangerous bug** — it requires no authentication, no user action, just a network retry.

2. A publisher can withdraw more than their balance by sending two concurrent requests, because the balance check is outside the transaction and `PublisherBalance` has no version-based concurrency control.

3. A settlement can release twice, paying the publisher double, because `releaseFundsInternal` doesn't verify the settlement hasn't already been released before updating it.

These are not theoretical — they are concrete race conditions in the current code. Combined with the fact that:
- Settlement releases leave no audit trail in the Transaction table
- Admin refunds can silently bypass accounting
- Refund after settlement release creates a unilateral customer credit without publisher clawback

**The architecture is salvageable** — the version-based concurrency on Wallet is well-designed and most payment flows are in transactions. But the three critical fixes (CF-1, CF-2, CF-3) and the high-priority fixes (HF-1 through HF-7) must be implemented before real money is at risk.

**Estimated fix effort:** 2-3 days for critical/high findings. Low effort relative to the risk.
