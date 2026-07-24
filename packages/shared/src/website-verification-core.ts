// DNS TXT verification state machine — pure core, dependency-injected.
//
// Same pattern as reconciliation-core: all the verification/revocation logic
// lives here so it can be unit-tested without Redis/BullMQ/node-dns. The worker
// is a thin adapter that injects the real prisma client + DNS lookup. No node
// `dns` import here, so this is safe to keep in the package index.
import type { DnsCheckResult } from "./dns-verification"
import { generateVerificationToken } from "./dns-verification"

export type DnsChecker = (
  websiteUrl: string,
  token: string,
) => Promise<DnsCheckResult>

export interface VerificationDeps {
  // Structurally-typed slice of PrismaClient — keeps this file framework-free.
  prisma: any
  checkDns: DnsChecker
  now?: () => Date
  // The sweep itself may run daily to expire overrides promptly; real DNS
  // checks remain on this slower cadence.
  dnsRecheckAfterMs?: number
  // Optional hook to trigger event-driven publisher trust recompute.
  onTrustEvent?: (
    publisherId: string | null | undefined,
    sourceEvent: string,
    reason?: string,
  ) => void | Promise<void>
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
  const staff = await prisma.staffMembership.findMany({
    select: { userId: true },
  })
  for (const s of staff) {
    await prisma.notification
      .create({
        data: { userId: s.userId, organizationId: null, type, message },
      })
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
  if (!website.publisherId || !website.verificationToken)
    return { skipped: "no_token" }
  if (
    website.verificationStatus === "VERIFIED" &&
    website.verificationMethod !== "SUPER_ADMIN_OVERRIDE"
  )
    return { skipped: "already_verified" }

  const publisher = await prisma.publisher.findUnique({
    where: { id: website.publisherId },
  })
  const organizationId = publisher?.organizationId ?? null
  const expectedVersion = website.verificationVersion

  const result = await checkDns(website.url, website.verificationToken)

  if (result.found) {
    // Token rotation: the proven token becomes activeVerifiedToken (what the
    // sweep re-checks, since it's what's in DNS), and a fresh token is minted
    // for the next verification cycle. Existing verification stays valid.
    const rotatedToken = generateVerificationToken()
    const upd = await prisma.website.updateMany({
      where: { id: website.id, verificationVersion: expectedVersion },
      data: {
        verificationStatus: "VERIFIED",
        verificationMethod: "DNS_TXT",
        verifiedAt: now,
        lastVerificationCheckAt: now,
        lastSuccessfulVerificationAt: now,
        activeVerifiedToken: website.verificationToken,
        verificationToken: rotatedToken,
        verificationCheckCount: { increment: 1 },
        consecutiveFailures: 0,
        verificationFailureReason: null,
        verificationOverrideExpiresAt: null,
        verificationOverrideReason: null,
        verifiedByUserId: null,
        verificationVersion: expectedVersion + 1,
      },
    })
    if (upd.count === 0) return { skipped: "version_conflict" }
    await prisma.auditLog.create({
      data: {
        action: "WEBSITE_VERIFIED",
        entityType: "Website",
        entityId: website.id,
        metadata: {
          domain: website.domain,
          publisherId: website.publisherId,
          organizationId,
          matchedHost: result.matchedHost,
        },
        userId: actorUserId ?? null,
        organizationId,
      },
    })
    await prisma.auditLog.create({
      data: {
        action: "WEBSITE_VERIFICATION_TOKEN_ROTATED",
        entityType: "Website",
        entityId: website.id,
        metadata: {
          domain: website.domain,
          publisherId: website.publisherId,
          organizationId,
        },
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
    await deps.onTrustEvent?.(
      website.publisherId,
      "WEBSITE_REVERIFIED",
      `website ${website.domain ?? website.url} verified`,
    )
    return { ok: true, status: "VERIFIED" }
  }

  const reason = result.reason ?? "Verification TXT record not found"

  // A failed voluntary TXT attempt must not prematurely destroy a still-live
  // Super Admin override. The scheduled sweep remains the authority that
  // revokes the override at its recorded expiry.
  if (
    website.verificationMethod === "SUPER_ADMIN_OVERRIDE" &&
    website.verificationOverrideExpiresAt &&
    new Date(website.verificationOverrideExpiresAt).getTime() > now.getTime()
  ) {
    const upd = await prisma.website.updateMany({
      where: { id: website.id, verificationVersion: expectedVersion },
      data: {
        lastVerificationCheckAt: now,
        verificationCheckCount: { increment: 1 },
        verificationFailureReason: reason,
      },
    })
    if (upd.count === 0) return { skipped: "version_conflict" }
    await prisma.auditLog.create({
      data: {
        action: "WEBSITE_TXT_VERIFICATION_FAILED_OVERRIDE_RETAINED",
        entityType: "Website",
        entityId: website.id,
        metadata: {
          domain: website.domain,
          publisherId: website.publisherId,
          organizationId,
          reason,
          overrideExpiresAt: website.verificationOverrideExpiresAt,
        },
        userId: actorUserId ?? null,
        organizationId,
      },
    })
    return {
      ok: false,
      status: "VERIFIED",
      reason: "TXT record not found; temporary override remains active",
    }
  }

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
      metadata: {
        domain: website.domain,
        publisherId: website.publisherId,
        organizationId,
        reason,
      },
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
  warned: number
}

// Revocation enforcement: a REVOKED domain's marketplace listings are hidden
// (PAUSED) so it can no longer sell, take new orders, or be approved/edited.
// Completed orders, settlements, and historical reporting are untouched.
export async function enforceRevocation(
  prisma: any,
  website: any,
  organizationId: string | null,
) {
  const hidden = await prisma.marketplaceListing.updateMany({
    where: {
      websiteId: website.id,
      status: { in: ["APPROVED", "PENDING_REVIEW", "DRAFT", "PAUSED"] },
    },
    data: { status: "PAUSED" },
  })
  await prisma.auditLog.create({
    data: {
      action: "WEBSITE_REVOKED_ENFORCEMENT",
      entityType: "Website",
      entityId: website.id,
      metadata: {
        domain: website.domain,
        publisherId: website.publisherId,
        organizationId,
        listingsHidden: hidden.count,
      },
      userId: null,
      organizationId,
    },
  })
  await notifyPublisherOwners(
    prisma,
    website.publisherId,
    organizationId,
    "WEBSITE_REVOKED_ENFORCEMENT",
    `Listings for ${website.domain ?? website.url} were hidden because domain ownership is no longer verified.`,
  )
  await notifyOps(
    prisma,
    "WEBSITE_REVOKED_ENFORCEMENT",
    `Revocation enforced on ${website.domain ?? website.url}: ${hidden.count} listing(s) hidden.`,
  )
  return hidden.count
}

// Periodic ownership health check (default 30 days). Transient DNS outages must
// not instantly revoke: a domain is REVOKED only after 3 consecutive failed
// checks. 1 failure warns the publisher, 2 notifies Operations, 3 revokes +
// enforces. A successful check resets the failure streak.
export async function runWebsiteReverifySweep(
  deps: VerificationDeps,
): Promise<SweepResult> {
  const { prisma, checkDns } = deps
  const sweepNow = (deps.now ?? (() => new Date()))()
  const dnsCutoff = new Date(
    sweepNow.getTime() - (deps.dnsRecheckAfterMs ?? 30 * 86_400_000),
  )
  const sites = await prisma.website.findMany({
    where: {
      verificationStatus: "VERIFIED",
      publisherId: { not: null },
      OR: [
        { verificationMethod: "SUPER_ADMIN_OVERRIDE" },
        {
          AND: [
            {
              OR: [
                { verificationMethod: "DNS_TXT" },
                { verificationMethod: null },
              ],
            },
            {
              OR: [
                { lastVerificationCheckAt: null },
                { lastVerificationCheckAt: { lte: dnsCutoff } },
              ],
            },
          ],
        },
      ],
    },
    select: { id: true },
  })

  let revoked = 0
  let refreshed = 0
  let warned = 0
  for (const { id } of sites) {
    const website = await prisma.website.findUnique({ where: { id } })
    if (!website?.publisherId) continue
    if (website.verificationStatus !== "VERIFIED") continue

    const publisher = await prisma.publisher.findUnique({
      where: { id: website.publisherId },
    })
    const organizationId = publisher?.organizationId ?? null
    const expectedVersion = website.verificationVersion
    const now = sweepNow

    // Break-glass verification has its own deterministic expiry. It is never
    // evaluated as DNS evidence and cannot silently become permanent.
    if (website.verificationMethod === "SUPER_ADMIN_OVERRIDE") {
      const expiresAt = website.verificationOverrideExpiresAt
        ? new Date(website.verificationOverrideExpiresAt)
        : null
      if (expiresAt && expiresAt.getTime() > now.getTime()) continue

      const reason = expiresAt
        ? "Super Admin verification override expired"
        : "Super Admin verification override has no valid expiry"
      const upd = await prisma.website.updateMany({
        where: {
          id: website.id,
          verificationVersion: expectedVersion,
          verificationStatus: "VERIFIED",
          verificationMethod: "SUPER_ADMIN_OVERRIDE",
        },
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
          action: "WEBSITE_DOMAIN_VERIFICATION_OVERRIDE_EXPIRED",
          entityType: "Website",
          entityId: website.id,
          metadata: {
            domain: website.domain,
            publisherId: website.publisherId,
            organizationId,
            reason,
            overrideExpiresAt: expiresAt,
            verifiedByUserId: website.verifiedByUserId,
          },
          userId: null,
          organizationId,
        },
      })
      await enforceRevocation(prisma, website, organizationId)
      await deps.onTrustEvent?.(
        website.publisherId,
        "WEBSITE_REVOKED",
        `temporary verification for ${website.domain ?? website.url} expired`,
      )
      continue
    }

    // Re-check the token actually proven present in DNS (survives rotation).
    const checkToken = website.activeVerifiedToken ?? website.verificationToken
    if (!checkToken) continue

    let result: DnsCheckResult
    try {
      result = await checkDns(website.url, checkToken)
    } catch {
      // Transient resolver failure: don't count it as a failure at all.
      continue
    }

    if (result.found) {
      await prisma.website.updateMany({
        where: { id: website.id, verificationVersion: expectedVersion },
        data: {
          lastVerificationCheckAt: now,
          lastSuccessfulVerificationAt: now,
          verificationCheckCount: { increment: 1 },
          consecutiveFailures: 0,
        },
      })
      refreshed++
      continue
    }

    const failures = (website.consecutiveFailures ?? 0) + 1
    const reason = result.reason ?? "Verification TXT record no longer present"

    if (failures >= 3) {
      const upd = await prisma.website.updateMany({
        where: {
          id: website.id,
          verificationVersion: expectedVersion,
          verificationStatus: "VERIFIED",
        },
        data: {
          verificationStatus: "REVOKED",
          lastVerificationCheckAt: now,
          verificationCheckCount: { increment: 1 },
          consecutiveFailures: failures,
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
          metadata: {
            domain: website.domain,
            publisherId: website.publisherId,
            organizationId,
            reason,
            consecutiveFailures: failures,
          },
          userId: null,
          organizationId,
        },
      })
      await notifyPublisherOwners(
        prisma,
        website.publisherId,
        organizationId,
        "WEBSITE_VERIFICATION_REVOKED",
        `Domain verification REVOKED for ${website.domain ?? website.url} after ${failures} failed checks. Re-add the TXT record and re-verify.`,
      )
      await notifyOps(
        prisma,
        "WEBSITE_VERIFICATION_REVOKED",
        `Website ${website.domain ?? website.url} (publisher ${website.publisherId}) REVOKED after ${failures} consecutive failures.`,
      )
      await enforceRevocation(prisma, website, organizationId)
      await deps.onTrustEvent?.(
        website.publisherId,
        "WEBSITE_REVOKED",
        `website ${website.domain ?? website.url} revoked`,
      )
      continue
    }

    // 1 or 2 failures — record + warn, do not revoke.
    await prisma.website.updateMany({
      where: { id: website.id, verificationVersion: expectedVersion },
      data: {
        lastVerificationCheckAt: now,
        verificationCheckCount: { increment: 1 },
        consecutiveFailures: failures,
        verificationFailureReason: reason,
      },
    })
    warned++
    await prisma.auditLog.create({
      data: {
        action: "WEBSITE_VERIFICATION_HEALTH_WARNING",
        entityType: "Website",
        entityId: website.id,
        metadata: {
          domain: website.domain,
          publisherId: website.publisherId,
          organizationId,
          consecutiveFailures: failures,
          reason,
        },
        userId: null,
        organizationId,
      },
    })
    await notifyPublisherOwners(
      prisma,
      website.publisherId,
      organizationId,
      "WEBSITE_VERIFICATION_HEALTH_WARNING",
      `Health check ${failures}/3 failed for ${website.domain ?? website.url}: ${reason}. Verify the TXT record is still present.`,
    )
    if (failures >= 2) {
      await notifyOps(
        prisma,
        "WEBSITE_VERIFICATION_HEALTH_WARNING",
        `Website ${website.domain ?? website.url} (publisher ${website.publisherId}) has ${failures} consecutive failed checks — one more revokes it.`,
      )
    }
  }
  return { ok: true, total: sites.length, revoked, refreshed, warned }
}
