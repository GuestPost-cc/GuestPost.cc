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
    },
  })
}
