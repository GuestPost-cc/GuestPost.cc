// DNS TXT verification state machine — pure core, dependency-injected.
//
// Same pattern as reconciliation-core: all the verification/revocation logic
// lives here so it can be unit-tested without Redis/BullMQ/node-dns. The worker
// is a thin adapter that injects the real prisma client + DNS lookup. No node
// `dns` import here, so this is safe to keep in the package index.
import type { DnsCheckResult } from "./dns-verification"

export type DnsChecker = (websiteUrl: string, token: string) => Promise<DnsCheckResult>

export interface VerificationDeps {
  // Structurally-typed slice of PrismaClient — keeps this file framework-free.
  prisma: any
  checkDns: DnsChecker
  now?: () => Date
}

// Notify every owner user of a publisher. Best-effort — a failed notification
// must never fail the verification transition.
async function notifyPublisherOwners(
  prisma: any,
  publisherId: string,
  organizationId: string | null,
  type: string,
  message: string,
) {
  const owners = await prisma.publisherMembership.findMany({
    where: { publisherId, role: "PUBLISHER_OWNER" },
    select: { userId: true },
  })
  for (const o of owners) {
    await prisma.notification
      .create({ data: { userId: o.userId, organizationId, type, message } })
      .catch(() => undefined)
  }
}

async function notifyOps(prisma: any, type: string, message: string) {
  const staff = await prisma.staffMembership.findMany({ select: { userId: true } })
  for (const s of staff) {
    await prisma.notification
      .create({ data: { userId: s.userId, organizationId: null, type, message } })
      .catch(() => undefined)
  }
}

export interface VerifyResult {
  ok?: boolean
  skipped?: string
  status?: string
  reason?: string
}

// Single DNS check + transition. Idempotent: an already-VERIFIED site is a
// no-op. Optimistic-lock guard on `verificationVersion` blocks replayed/raced
// jobs from clobbering a newer state.
export async function runWebsiteVerify(
  deps: VerificationDeps,
  websiteId: string,
  actorUserId?: string,
): Promise<VerifyResult> {
  const { prisma, checkDns } = deps
  const now = (deps.now ?? (() => new Date()))()

  const website = await prisma.website.findUnique({ where: { id: websiteId } })
  if (!website) return { skipped: "not_found" }
  if (!website.publisherId || !website.verificationToken) return { skipped: "no_token" }
  if (website.verificationStatus === "VERIFIED") return { skipped: "already_verified" }

  const publisher = await prisma.publisher.findUnique({ where: { id: website.publisherId } })
  const organizationId = publisher?.organizationId ?? null
  const expectedVersion = website.verificationVersion

  const result = await checkDns(website.url, website.verificationToken)

  if (result.found) {
    const upd = await prisma.website.updateMany({
      where: { id: website.id, verificationVersion: expectedVersion },
      data: {
        verificationStatus: "VERIFIED",
        verifiedAt: now,
        lastVerificationCheckAt: now,
        verificationFailureReason: null,
        verificationVersion: expectedVersion + 1,
      },
    })
    if (upd.count === 0) return { skipped: "version_conflict" }
    await prisma.auditLog.create({
      data: {
        action: "WEBSITE_VERIFIED",
        entityType: "Website",
        entityId: website.id,
        metadata: { domain: website.domain, publisherId: website.publisherId, organizationId, matchedHost: result.matchedHost },
        userId: actorUserId ?? null,
        organizationId,
      },
    })
    await notifyPublisherOwners(
      prisma,
      website.publisherId,
      organizationId,
      "WEBSITE_VERIFIED",
      `Domain ownership verified for ${website.domain ?? website.url}. Your website can now be listed on the marketplace.`,
    )
    return { ok: true, status: "VERIFIED" }
  }

  const reason = result.reason ?? "Verification TXT record not found"
  const upd = await prisma.website.updateMany({
    where: { id: website.id, verificationVersion: expectedVersion },
    data: {
      verificationStatus: "VERIFICATION_FAILED",
      lastVerificationCheckAt: now,
      verificationFailureReason: reason,
      verificationVersion: expectedVersion + 1,
    },
  })
  if (upd.count === 0) return { skipped: "version_conflict" }
  await prisma.auditLog.create({
    data: {
      action: "WEBSITE_VERIFICATION_FAILED",
      entityType: "Website",
      entityId: website.id,
      metadata: { domain: website.domain, publisherId: website.publisherId, organizationId, reason },
      userId: actorUserId ?? null,
      organizationId,
    },
  })
  await notifyPublisherOwners(
    prisma,
    website.publisherId,
    organizationId,
    "WEBSITE_VERIFICATION_FAILED",
    `Domain verification failed for ${website.domain ?? website.url}: ${reason}. DNS changes can take up to 48 hours — check the TXT record and try again.`,
  )
  return { ok: false, status: "VERIFICATION_FAILED", reason }
}

export interface SweepResult {
  ok: boolean
  total: number
  revoked: number
  refreshed: number
}

// 30-day re-verification sweep. A VERIFIED site whose TXT record vanished is
// REVOKED; the rest get lastVerificationCheckAt refreshed. A transient resolver
// error is logged and skipped (never revokes on a single failed lookup).
export async function runWebsiteReverifySweep(deps: VerificationDeps): Promise<SweepResult> {
  const { prisma, checkDns } = deps
  const sites = await prisma.website.findMany({
    where: { verificationStatus: "VERIFIED", verificationToken: { not: null }, publisherId: { not: null } },
    select: { id: true },
  })

  let revoked = 0
  let refreshed = 0
  for (const { id } of sites) {
    const website = await prisma.website.findUnique({ where: { id } })
    if (!website || !website.verificationToken || !website.publisherId) continue
    if (website.verificationStatus !== "VERIFIED") continue

    const publisher = await prisma.publisher.findUnique({ where: { id: website.publisherId } })
    const organizationId = publisher?.organizationId ?? null
    const expectedVersion = website.verificationVersion
    const now = (deps.now ?? (() => new Date()))()

    let result: DnsCheckResult
    try {
      result = await checkDns(website.url, website.verificationToken)
    } catch {
      // Transient resolver failure: don't revoke on a single error.
      continue
    }

    if (result.found) {
      await prisma.website.updateMany({
        where: { id: website.id, verificationVersion: expectedVersion },
        data: { lastVerificationCheckAt: now },
      })
      refreshed++
      continue
    }

    const reason = result.reason ?? "Verification TXT record no longer present"
    const upd = await prisma.website.updateMany({
      where: { id: website.id, verificationVersion: expectedVersion, verificationStatus: "VERIFIED" },
      data: {
        verificationStatus: "REVOKED",
        lastVerificationCheckAt: now,
        verificationFailureReason: reason,
        verificationVersion: expectedVersion + 1,
      },
    })
    if (upd.count === 0) continue
    revoked++
    await prisma.auditLog.create({
      data: {
        action: "WEBSITE_VERIFICATION_REVOKED",
        entityType: "Website",
        entityId: website.id,
        metadata: { domain: website.domain, publisherId: website.publisherId, organizationId, reason },
        userId: null,
        organizationId,
      },
    })
    await notifyPublisherOwners(
      prisma,
      website.publisherId,
      organizationId,
      "WEBSITE_VERIFICATION_REVOKED",
      `Domain verification REVOKED for ${website.domain ?? website.url}: the TXT record was removed. Re-add it and re-verify to keep your listings active.`,
    )
    await notifyOps(
      prisma,
      "WEBSITE_VERIFICATION_REVOKED",
      `Website ${website.domain ?? website.url} (publisher ${website.publisherId}) was REVOKED — TXT record removed.`,
    )
  }
  return { ok: true, total: sites.length, revoked, refreshed }
}
