/**
 * Phase 7.10.2 — minimum-viable factory library.
 *
 * Each factory takes a Prisma client + optional override object; supplies safe
 * defaults; returns the created row. NOT a general-purpose factory library —
 * the scope is the in-flight Spec 1 (claim race). Future integration specs
 * extend these as needed (e.g. by adding `withMembership`, `withStaffRole`,
 * etc. modifiers when auth-forgery work lands in Phase 7.10.2.1).
 *
 * Naming: `make<Entity>` returns the row. No builder pattern — straight
 * functions with overrides keep the call site readable for proof-of-life
 * specs. If the library grows to 10+ entities the pattern may need a
 * rethink, but for 4 entities a builder DSL is over-engineering.
 *
 * IDs are auto-generated via Prisma's cuid() defaults. Slugs / emails get
 * a process.pid + Date.now() suffix to keep tests isolated even when
 * running in the same DB across multiple test apps (shouldn't happen with
 * TEMPLATE clone strategy, but defense in depth costs nothing).
 */

type AnyPrisma = any // PrismaService; typed loosely to avoid eager import side effects

let counter = 0
const uniqueSuffix = () => `${process.pid}_${Date.now()}_${counter++}`

// ─── Organization ─────────────────────────────────────────────────────────────
export async function makeOrganization(
  prisma: AnyPrisma,
  overrides: Partial<{ name: string; slug: string; plan: string }> = {},
) {
  const suffix = uniqueSuffix()
  return prisma.organization.create({
    data: {
      name: overrides.name ?? `Org ${suffix}`,
      slug: overrides.slug ?? `org-${suffix}`,
      plan: overrides.plan ?? "free",
    },
  })
}

// ─── User ─────────────────────────────────────────────────────────────────────
export async function makeUser(
  prisma: AnyPrisma,
  overrides: Partial<{
    email: string
    name: string
    userType: "CUSTOMER" | "PUBLISHER" | "STAFF"
    emailVerified: boolean
  }> = {},
) {
  const suffix = uniqueSuffix()
  return prisma.user.create({
    data: {
      email: overrides.email ?? `user-${suffix}@test.local`,
      name: overrides.name ?? `User ${suffix}`,
      userType: overrides.userType ?? "CUSTOMER",
      emailVerified: overrides.emailVerified ?? true,
    },
  })
}

// ─── Website ──────────────────────────────────────────────────────────────────
export async function makeWebsite(
  prisma: AnyPrisma,
  overrides: Partial<{
    url: string
    ownershipType: "PUBLISHER" | "PLATFORM"
    verificationStatus: "PENDING_VERIFICATION" | "VERIFIED" | "REVOKED"
    publisherId: string | null
    managedByUserId: string | null
  }> = {},
) {
  const suffix = uniqueSuffix()
  return prisma.website.create({
    data: {
      url: overrides.url ?? `https://example-${suffix}.test`,
      ownershipType: overrides.ownershipType ?? "PUBLISHER",
      verificationStatus: overrides.verificationStatus ?? "VERIFIED",
      publisherId: overrides.publisherId ?? null,
      managedByUserId: overrides.managedByUserId ?? null,
    },
  })
}

// ─── Order ────────────────────────────────────────────────────────────────────
// Minimum FK chain to satisfy claim(): Order with fulfillmentChannel=PLATFORM
// in an operations-queue status. Caller supplies organizationId + customerId +
// websiteId; everything else has a safe default.
export async function makeOrder(
  prisma: AnyPrisma,
  args: {
    organizationId: string
    customerId: string
    websiteId?: string
    type?:
      | "GUEST_POST"
      | "NICHE_EDIT"
      | "EDITORIAL_LINK"
      | "OUTREACH_LINK"
      | "LOCAL_CITATION"
      | "FOUNDATION_LINK"
      | "BLOG_ARTICLE"
      | "SEO_CONTENT"
    status?:
      | "DRAFT"
      | "PENDING_PAYMENT"
      | "PAID"
      | "SUBMITTED"
      | "ACCEPTED"
      | "CONTENT_REQUESTED"
      | "CONTENT_CREATION"
      | "CONTENT_READY"
      | "CUSTOMER_REVIEW"
      | "APPROVED"
      | "PUBLISHED"
    fulfillmentChannel?: "PUBLISHER" | "PLATFORM"
    amount?: number
    title?: string
    paymentStatus?: string
  },
) {
  const suffix = uniqueSuffix()
  return prisma.order.create({
    data: {
      type: args.type ?? "GUEST_POST",
      status: args.status ?? "APPROVED", // in-operations-queue per claim() guard
      organizationId: args.organizationId,
      customerId: args.customerId,
      websiteId: args.websiteId ?? null,
      fulfillmentChannel: args.fulfillmentChannel ?? "PLATFORM",
      amount: args.amount ?? 100,
      title: args.title ?? `Test order ${suffix}`,
      paymentStatus: args.paymentStatus ?? "PENDING",
    },
  })
}

// ─── OrderItem ──────────────────────────────────────────────────────────────
// Required by SettlementService.createSettlement() to resolve the publisher
// from the order (see settlements.service.ts:78-87).
export async function makeOrderItem(
  prisma: AnyPrisma,
  args: {
    orderId: string
    websiteId: string
    price?: number
  },
) {
  return prisma.orderItem.create({
    data: {
      orderId: args.orderId,
      websiteId: args.websiteId,
      price: args.price ?? 100,
      status: "PAID",
    },
  })
}

// ─── OrderDeliveryVersion ──────────────────────────────────────────────────
// Required by evaluateSettlementEligibility() — settlement gating needs a
// VERIFIED delivery version linked to the order (see settlement-gating.ts:30-49).
export async function makeOrderDeliveryVersion(
  prisma: AnyPrisma,
  args: {
    orderId: string
    submittedByUserId: string
    publishedUrl?: string
    verificationStatus?: string
  },
) {
  const suffix = uniqueSuffix()
  return prisma.orderDeliveryVersion.create({
    data: {
      orderId: args.orderId,
      version: 1,
      publishedUrl:
        args.publishedUrl ?? `https://example.com/article-${suffix}`,
      normalizedUrl:
        args.publishedUrl ?? `https://example.com/article-${suffix}`,
      submittedByUserId: args.submittedByUserId,
      verificationStatus: args.verificationStatus ?? "VERIFIED",
    },
  })
}

// ─── Publisher ─────────────────────────────────────────────────────────────
// Minimal FK chain to satisfy Settlement: publisher belongs to an org.
export async function makePublisher(
  prisma: AnyPrisma,
  args: {
    organizationId: string
    name?: string
    email?: string
    tier?: string
  },
) {
  const suffix = uniqueSuffix()
  return prisma.publisher.create({
    data: {
      name: args.name ?? `Publisher ${suffix}`,
      email: args.email ?? `publisher-${suffix}@test.local`,
      organizationId: args.organizationId,
      tier: args.tier ?? "NEW",
    },
  })
}

// ─── Wallet ────────────────────────────────────────────────────────────────
// One wallet per organization (see @@unique([organizationId]) on the schema).
// Tests must create at most one wallet per org.
export async function makeWallet(
  prisma: AnyPrisma,
  args: {
    organizationId: string
    availableBalance?: number
  },
) {
  return prisma.wallet.create({
    data: {
      organizationId: args.organizationId,
      availableBalance: args.availableBalance ?? 0,
      reservedBalance: 0,
      currency: "USD",
    },
  })
}

// ─── Transaction ───────────────────────────────────────────────────────────
// reference must be globally unique (see @@unique([reference]) on the schema).
// Use crypto.randomUUID() in tests — Date.now() is not collision-proof across
// parallel jest workers.
export async function makeTransaction(
  prisma: AnyPrisma,
  args: {
    walletId: string
    amount: number
    type: string
    reference: string
    orderId?: string | null
    settlementId?: string | null
    publisherId?: string | null
    description?: string
    providerRef?: string
  },
) {
  return prisma.transaction.create({
    data: {
      walletId: args.walletId,
      amount: args.amount,
      type: args.type,
      reference: args.reference,
      orderId: args.orderId ?? null,
      settlementId: args.settlementId ?? null,
      publisherId: args.publisherId ?? null,
      description: args.description ?? null,
      providerRef: args.providerRef ?? null,
      currency: "USD",
    },
  })
}

// ─── Settlement ────────────────────────────────────────────────────────────
// FK chain: Settlement → Order + Publisher.
// Creates a pending settlement. Specs call services to transition status.
export async function makeSettlement(
  prisma: AnyPrisma,
  args: {
    orderId: string
    publisherId: string
    grossAmount: number
    publisherAmount: number
    platformFee?: number
    status?: string
  },
) {
  return prisma.settlement.create({
    data: {
      orderId: args.orderId,
      publisherId: args.publisherId,
      grossAmount: args.grossAmount,
      publisherAmount: args.publisherAmount,
      platformFee: args.platformFee ?? 0,
      status: args.status ?? "PENDING",
    },
  })
}
