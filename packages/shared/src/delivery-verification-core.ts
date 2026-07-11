// Delivery verification state machine — node-only (cheerio HTML parse). NOT in
// the package index; worker + tests deep-import "@guestpost/shared/dist/
// delivery-verification-core". The worker injects fetch + object storage so
// this stays unit-testable without network/S3.
//
// Independently verifies a published delivery: fetch URL, resolve redirects,
// validate HTTP, parse HTML, confirm the target link + anchor, hash + snapshot
// the page, persist immutable evidence, run fraud detection, and transition the
// delivery version VERIFIED / FAILED / MANUAL_REVIEW (version-guarded). All
// comparisons use normalized URLs.

import { createHash } from "node:crypto"
import * as cheerio from "cheerio"
import { normalizeUrl, sameDomain, urlsMatch } from "./url-normalize"
import { defaultWorkflowConfig } from "./workflow/workflow-config"

export interface FetchResult {
  finalUrl: string
  status: number
  headers: Record<string, string>
  html: string
  redirectChain: string[]
  error?: string // network/DNS/timeout — distinct from an HTTP error status
}

export type DeliveryFetcher = (url: string) => Promise<FetchResult>
export type ObjectPutter = (
  key: string,
  body: string | Buffer,
  contentType: string,
) => Promise<{ objectKey: string }>

export interface DeliveryDeps {
  prisma: any
  fetchUrl: DeliveryFetcher
  putObject: ObjectPutter
  now?: () => Date
  // Optional hook to trigger event-driven publisher trust recompute.
  onTrustEvent?: (
    publisherId: string | null | undefined,
    sourceEvent: string,
    reason?: string,
  ) => void | Promise<void>
}

export interface DeliveryVerifyResult {
  skipped?: string
  status?: string
  retryable?: boolean
  reason?: string
}

// HTTP statuses accepted after redirect resolution.
const ACCEPT_STATUSES = new Set([200, 301, 302])

async function notifyUsers(
  prisma: any,
  userIds: string[],
  organizationId: string | null,
  type: string,
  message: string,
) {
  for (const userId of userIds) {
    await prisma.notification
      .create({ data: { userId, organizationId, type, message } })
      .catch(() => undefined)
  }
}

async function publisherOwnerIds(
  prisma: any,
  publisherId: string | null,
): Promise<string[]> {
  if (!publisherId) return []
  const owners = await prisma.publisherMembership.findMany({
    where: { publisherId, role: "PUBLISHER_OWNER" },
    select: { userId: true },
  })
  return owners.map((o: any) => o.userId)
}

async function staffIds(prisma: any): Promise<string[]> {
  const staff = await prisma.staffMembership.findMany({
    select: { userId: true },
  })
  return staff.map((s: any) => s.userId)
}

// Common audit metadata shape required by spec for every ORDER_DELIVERY_* event.
function auditMeta(
  order: any,
  version: any,
  extra: Record<string, unknown> = {},
) {
  return {
    orderId: order.id,
    deliveryVersionId: version.id,
    websiteId: order.websiteId ?? null,
    publisherId: order.website?.publisherId ?? null,
    organizationId: order.organizationId,
    publishedUrl: version.publishedUrl,
    ...extra,
  }
}

async function audit(
  prisma: any,
  action: string,
  order: any,
  version: any,
  actorId: string | null,
  extra: Record<string, unknown> = {},
) {
  await prisma.auditLog.create({
    data: {
      action,
      entityType: "OrderDeliveryVersion",
      entityId: version.id,
      metadata: auditMeta(order, version, extra),
      userId: actorId,
      organizationId: order.organizationId,
    },
  })
}

// Parse the captured HTML for evidence fields + the target link / anchor.
function analyzeHtml(
  html: string,
  targetUrl: string | null,
  anchorText: string | null,
) {
  const $ = cheerio.load(html)
  const pageTitle = $("title").first().text().trim() || null
  const metaTitle =
    $('meta[property="og:title"]').attr("content")?.trim() ||
    $('meta[name="title"]').attr("content")?.trim() ||
    null
  const canonicalUrl = $('link[rel="canonical"]').attr("href")?.trim() || null

  let linkFound = false
  let targetUrlMatched = false
  let anchorFound = false
  let verifiedTargetUrl: string | null = null
  let verifiedAnchorText: string | null = null

  if (!targetUrl) {
    // Content-only delivery — no link to verify.
    linkFound = true
    targetUrlMatched = true
  } else {
    $("a[href]").each((_, el) => {
      const href = $(el).attr("href") || ""
      let abs = href
      try {
        abs = canonicalUrl ? new URL(href, canonicalUrl).toString() : href
      } catch {
        abs = href
      }
      if (urlsMatch(abs, targetUrl)) {
        linkFound = true
        targetUrlMatched = true
        verifiedTargetUrl = normalizeUrl(abs)
        const text = $(el).text().trim()
        verifiedAnchorText = text || verifiedAnchorText
        if (
          anchorText &&
          text.toLowerCase() === anchorText.trim().toLowerCase()
        ) {
          anchorFound = true
        }
        return false // stop at first exact match
      }
      return undefined
    })
  }

  // No anchor requirement -> anchor passes vacuously.
  if (!anchorText) anchorFound = true

  return {
    pageTitle,
    metaTitle,
    canonicalUrl,
    linkFound,
    targetUrlMatched,
    anchorFound,
    verifiedTargetUrl,
    verifiedAnchorText,
  }
}

// Fraud heuristics. Each match creates a DeliveryFraudFlag (deduped by type) +
// staff notification + audit.
async function runFraudDetection(
  deps: DeliveryDeps,
  order: any,
  version: any,
  analysis: { targetUrlMatched: boolean; anchorFound: boolean },
) {
  const { prisma } = deps
  const flags: Array<{ type: string; details: any }> = []

  // 1. Published URL reused on a different order
  const reuse = await prisma.orderDeliveryVersion.findFirst({
    where: { normalizedUrl: version.normalizedUrl, orderId: { not: order.id } },
    select: { id: true, orderId: true },
  })
  if (reuse)
    flags.push({
      type: "URL_REUSED",
      details: { otherOrderId: reuse.orderId, otherVersionId: reuse.id },
    })

  // 2. Target URL mismatch (order expected a target but it wasn't matched)
  if (order.targetUrl && !analysis.targetUrlMatched) {
    flags.push({
      type: "TARGET_MISMATCH",
      details: { expected: order.targetUrl },
    })
  }

  // 3. Anchor mismatch
  if (order.anchorText && !analysis.anchorFound) {
    flags.push({
      type: "ANCHOR_MISMATCH",
      details: { expected: order.anchorText },
    })
  }

  // 4. Domain mismatch — published on a different domain than the order website
  if (
    order.website?.url &&
    !sameDomain(version.publishedUrl, order.website.url)
  ) {
    flags.push({
      type: "DOMAIN_MISMATCH",
      details: {
        publishedUrl: version.publishedUrl,
        websiteUrl: order.website.url,
      },
    })
  }

  // 5. Suspicious rapid delivery — same submitter, many submissions in 60s
  const since = new Date((deps.now ?? (() => new Date()))().getTime() - 60_000)
  const rapid = await prisma.orderDeliveryVersion.count({
    where: {
      submittedByUserId: version.submittedByUserId,
      submittedAt: { gte: since },
    },
  })
  if (rapid >= 5)
    flags.push({
      type: "RAPID_DELIVERY",
      details: { count: rapid, windowSeconds: 60 },
    })

  for (const f of flags) {
    // Dedupe: one flag per (version, type)
    const exists = await prisma.deliveryFraudFlag.findFirst({
      where: { deliveryVersionId: version.id, type: f.type },
      select: { id: true },
    })
    if (exists) continue
    await prisma.deliveryFraudFlag.create({
      data: {
        orderId: order.id,
        deliveryVersionId: version.id,
        type: f.type,
        details: f.details,
      },
    })
    await audit(prisma, "ORDER_DELIVERY_FRAUD_FLAGGED", order, version, null, {
      fraudType: f.type,
      details: f.details,
    })
  }

  if (flags.length > 0) {
    const ids = await staffIds(prisma)
    await notifyUsers(
      prisma,
      ids,
      null,
      "ORDER_DELIVERY_FRAUD_FLAGGED",
      `Fraud flags on order ${order.id}: ${flags.map((f) => f.type).join(", ")}. Review before settlement.`,
    )
  }
  return flags.map((f) => f.type)
}

// Main entry. `isFinalAttempt` tells us to route transient failures to
// MANUAL_REVIEW instead of throwing for another retry.
export async function runDeliveryVerification(
  deps: DeliveryDeps,
  deliveryVersionId: string,
  opts: { actorUserId?: string; isFinalAttempt?: boolean } = {},
): Promise<DeliveryVerifyResult> {
  const { prisma, fetchUrl, putObject } = deps
  const now = (deps.now ?? (() => new Date()))()

  const version = await prisma.orderDeliveryVersion.findUnique({
    where: { id: deliveryVersionId },
  })
  if (!version) return { skipped: "not_found" }
  // Idempotent: a delivery already auto-VERIFIED is not re-run by the worker.
  if (version.verificationStatus === "VERIFIED")
    return { skipped: "already_verified" }
  // Superseded versions are immutable history — never re-verify.
  if (version.supersededByVersion != null) return { skipped: "superseded" }

  const order = await prisma.order.findUnique({
    where: { id: version.orderId },
    include: { website: { select: { url: true, publisherId: true } } },
  })
  if (!order) return { skipped: "order_not_found" }

  await audit(
    prisma,
    "ORDER_DELIVERY_VERIFICATION_STARTED",
    order,
    version,
    opts.actorUserId ?? null,
  )

  const expectedVersion = version.verificationVersion

  // ── Fetch ────────────────────────────────────────────────────────────────
  let fetched: FetchResult
  try {
    fetched = await fetchUrl(version.publishedUrl)
  } catch (err: any) {
    fetched = {
      finalUrl: version.publishedUrl,
      status: 0,
      headers: {},
      html: "",
      redirectChain: [],
      error: err?.message ?? "fetch failed",
    }
  }

  const transientFailure =
    !!fetched.error || !ACCEPT_STATUSES.has(fetched.status)
  if (transientFailure) {
    if (!opts.isFinalAttempt) {
      // Throw so BullMQ retries with backoff (5/15/60m).
      await audit(
        prisma,
        "ORDER_DELIVERY_VERIFICATION_RETRIED",
        order,
        version,
        null,
        {
          httpStatus: fetched.status,
          error: fetched.error ?? null,
        },
      )
      await prisma.orderDeliveryVersion.updateMany({
        where: { id: version.id, verificationVersion: expectedVersion },
        data: { verificationStatus: "RETRYING" },
      })
      throw new Error(
        `Delivery fetch failed (status ${fetched.status}${fetched.error ? `, ${fetched.error}` : ""}) — retrying`,
      )
    }
    // Exhausted retries → MANUAL_REVIEW (a human must look).
    const reason = fetched.error
      ? `Fetch error: ${fetched.error}`
      : `HTTP ${fetched.status} after redirects`
    const upd = await prisma.orderDeliveryVersion.updateMany({
      where: { id: version.id, verificationVersion: expectedVersion },
      data: {
        verificationStatus: "MANUAL_REVIEW",
        verificationFailureReason: reason,
        verificationVersion: expectedVersion + 1,
      },
    })
    if (upd.count === 0) return { skipped: "version_conflict" }
    await audit(prisma, "ORDER_DELIVERY_ESCALATED", order, version, null, {
      reason,
      manualReview: true,
      httpStatus: fetched.status,
      error: fetched.error ?? null,
      redirectChain: fetched.redirectChain,
    })
    await prisma.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "VERIFICATION_ESCALATED",
        actorId: null,
        message: `Verification escalated to manual review: ${reason}`,
        metadata: {
          deliveryVersionId: version.id,
          reason,
          httpStatus: fetched.status,
          error: fetched.error ?? null,
          redirectChain: fetched.redirectChain,
        },
      },
    })
    const ids = await staffIds(prisma)
    await notifyUsers(
      prisma,
      ids,
      null,
      "ORDER_DELIVERY_MANUAL_REVIEW",
      `Delivery for order ${order.id} needs manual review: ${reason}`,
    )
    await notifyUsers(
      prisma,
      await publisherOwnerIds(prisma, order.website?.publisherId),
      order.organizationId,
      "ORDER_DELIVERY_MANUAL_REVIEW",
      `Your delivery for order ${order.id} could not be auto-verified and is under manual review.`,
    )
    return { status: "MANUAL_REVIEW", reason }
  }

  // ── Parse + analyze ───────────────────────────────────────────────────────
  const analysis = analyzeHtml(
    fetched.html,
    order.targetUrl ?? null,
    order.anchorText ?? null,
  )
  const htmlHash = createHash("sha256").update(fetched.html).digest("hex")

  // ── Snapshot (permanent) ───────────────────────────────────────────────────
  const htmlKey = `deliveries/${version.id}/page.html`
  let snapshotStored = false
  try {
    await putObject(htmlKey, fetched.html, "text/html; charset=utf-8")
    await prisma.deliverySnapshot.create({
      data: {
        deliveryVersionId: version.id,
        htmlObjectKey: htmlKey,
        responseHeaders: fetched.headers as any,
      },
    })
    snapshotStored = true
    await audit(
      prisma,
      "ORDER_DELIVERY_SNAPSHOT_CAPTURED",
      order,
      version,
      null,
      { htmlObjectKey: htmlKey, htmlHash },
    )
  } catch (err: any) {
    // Snapshot storage failure must not lose the verification result — log via
    // audit and continue. Evidence row still records the hash.
    await audit(
      prisma,
      "ORDER_DELIVERY_SNAPSHOT_CAPTURED",
      order,
      version,
      null,
      { error: err?.message ?? "snapshot failed" },
    )
  }

  // ── Immutable evidence ──────────────────────────────────────────────────────
  await prisma.deliveryVerificationEvidence.create({
    data: {
      deliveryVersionId: version.id,
      pageTitle: analysis.pageTitle,
      metaTitle: analysis.metaTitle,
      canonicalUrl: analysis.canonicalUrl,
      resolvedUrl: fetched.finalUrl,
      httpStatus: fetched.status,
      anchorFound: analysis.anchorFound,
      linkFound: analysis.linkFound,
      targetUrlMatched: analysis.targetUrlMatched,
      verifiedAnchorText: analysis.verifiedAnchorText,
      verifiedTargetUrl: analysis.verifiedTargetUrl,
      htmlHash,
      redirectChain: fetched.redirectChain as any,
      checkedAt: now,
    },
  })

  // ── Decide + transition (version-guarded) ───────────────────────────────────
  const pass =
    analysis.linkFound && analysis.targetUrlMatched && analysis.anchorFound
  const newStatus = pass ? "VERIFIED" : "FAILED"
  const failureReason = pass
    ? null
    : [
        !analysis.targetUrlMatched && order.targetUrl
          ? "target URL not found on page"
          : null,
        !analysis.anchorFound && order.anchorText
          ? "anchor text mismatch"
          : null,
      ]
        .filter(Boolean)
        .join("; ") || "link verification failed"

  const upd = await prisma.orderDeliveryVersion.updateMany({
    where: { id: version.id, verificationVersion: expectedVersion },
    data: {
      verificationStatus: newStatus,
      verificationFailureReason: failureReason,
      verificationVersion: expectedVersion + 1,
    },
  })
  if (upd.count === 0) return { skipped: "version_conflict" }

  // Fraud detection runs on every checked delivery (runs before the
  // order status flip so events can reference fraud outcomes).
  const fraudTypes = await runFraudDetection(deps, order, version, analysis)

  // Mirror onto the order (denormalized) when verified + currently published.
  if (pass) {
    const reviewWindowMs =
      defaultWorkflowConfig.reviewWindowDays * 24 * 60 * 60 * 1000
    const autoAcceptAt = new Date(now.getTime() + reviewWindowMs)
    await prisma.order.updateMany({
      where: { id: order.id, status: "PUBLISHED" },
      data: {
        status: "VERIFIED",
        verifiedAt: now,
        verifiedBy: "system",
        verifyMethod: "AUTO",
        autoAcceptAt,
      },
    })
    await prisma.orderEvent.create({
      data: {
        orderId: order.id,
        eventType: "VERIFIED_AUTO",
        actorId: "system",
        message: `Delivery auto-verified — review window expires ${autoAcceptAt.toISOString()}`,
        metadata: {
          httpStatus: fetched.status,
          resolvedUrl: fetched.finalUrl,
          targetUrlMatched: analysis.targetUrlMatched,
          anchorFound: analysis.anchorFound,
          htmlHash,
          snapshotStored,
          fraudTypes,
        },
      },
    })
  }

  // Audit + notify
  await audit(
    prisma,
    pass ? "ORDER_DELIVERY_AUTO_VERIFIED" : "ORDER_DELIVERY_AUTO_FAILED",
    order,
    version,
    null,
    {
      httpStatus: fetched.status,
      resolvedUrl: fetched.finalUrl,
      targetUrlMatched: analysis.targetUrlMatched,
      anchorFound: analysis.anchorFound,
      htmlHash,
      snapshotStored,
      fraudTypes,
      reason: failureReason,
    },
  )

  const ownerIds = await publisherOwnerIds(prisma, order.website?.publisherId)
  if (pass) {
    await notifyUsers(
      prisma,
      ownerIds,
      order.organizationId,
      "ORDER_DELIVERY_VERIFIED",
      `Delivery verified for order ${order.id}.`,
    )
    await notifyUsers(
      prisma,
      [order.customerId],
      order.organizationId,
      "ORDER_VERIFICATION_PASSED",
      `Your order ${order.id} delivery was verified.`,
    )
  } else {
    await notifyUsers(
      prisma,
      ownerIds,
      order.organizationId,
      "ORDER_DELIVERY_FAILED",
      `Delivery verification failed for order ${order.id}: ${failureReason}.`,
    )
    await notifyUsers(
      prisma,
      [order.customerId],
      order.organizationId,
      "ORDER_VERIFICATION_FAILED",
      `Your order ${order.id} delivery could not be verified.`,
    )
  }

  return { status: newStatus, reason: failureReason ?? undefined }
}

// ── Settlement-hold link monitoring ─────────────────────────────────────────
// During the payout hold the live link is re-checked. If the publisher removed
// or changed it, the active delivery is marked FAILED, a LINK_REMOVED fraud
// flag is raised (which settlement gating blocks on), and everyone is notified.

export interface LinkRecheckResult {
  skipped?: string
  ok?: boolean
  removed?: boolean
  restored?: boolean
}

export async function runDeliveryLinkRecheck(
  deps: DeliveryDeps,
  deliveryVersionId: string,
): Promise<LinkRecheckResult> {
  const { prisma, fetchUrl } = deps
  const now = (deps.now ?? (() => new Date()))()

  const version = await prisma.orderDeliveryVersion.findUnique({
    where: { id: deliveryVersionId },
  })
  if (!version) return { skipped: "not_found" }
  if (version.supersededByVersion != null) return { skipped: "superseded" }

  // We monitor VERIFIED deliveries (detect removal) and FAILED deliveries that
  // were flagged LINK_REMOVED (detect restoration). Anything else is skipped.
  const hadRemovalFlag =
    version.verificationStatus === "FAILED"
      ? await prisma.deliveryFraudFlag.findFirst({
          where: { deliveryVersionId: version.id, type: "LINK_REMOVED" },
          select: { id: true },
        })
      : null
  if (version.verificationStatus !== "VERIFIED" && !hadRemovalFlag)
    return { skipped: "not_verified" }

  const order = await prisma.order.findUnique({
    where: { id: version.orderId },
    include: { website: { select: { url: true, publisherId: true } } },
  })
  if (!order) return { skipped: "order_not_found" }
  const publisherId = order.website?.publisherId

  let fetched: FetchResult
  try {
    fetched = await fetchUrl(version.publishedUrl)
  } catch (err: any) {
    fetched = {
      finalUrl: version.publishedUrl,
      status: 0,
      headers: {},
      html: "",
      redirectChain: [],
      error: err?.message ?? "fetch failed",
    }
  }
  // A transient outage is NOT a removal — never penalize the publisher for it.
  if (fetched.error || !ACCEPT_STATUSES.has(fetched.status))
    return { skipped: "transient" }

  const analysis = analyzeHtml(
    fetched.html,
    order.targetUrl ?? null,
    order.anchorText ?? null,
  )
  const stillPresent =
    analysis.linkFound && analysis.targetUrlMatched && analysis.anchorFound

  // ── Restoration path: a previously-removed link is back ──────────────────
  if (hadRemovalFlag) {
    if (!stillPresent) return { ok: true } // still gone
    const upd = await prisma.orderDeliveryVersion.updateMany({
      where: {
        id: version.id,
        verificationVersion: version.verificationVersion,
      },
      data: {
        verificationStatus: "VERIFIED",
        verificationFailureReason: null,
        verificationVersion: version.verificationVersion + 1,
      },
    })
    if (upd.count === 0) return { skipped: "version_conflict" }
    await audit(prisma, "ORDER_DELIVERY_LINK_RESTORED", order, version, null, {
      httpStatus: fetched.status,
    })
    await notifyUsers(
      prisma,
      await staffIds(prisma),
      null,
      "ORDER_DELIVERY_LINK_RESTORED",
      `Link restored on order ${order.id}. Note: the LINK_REMOVED fraud flag remains for review.`,
    )
    // Restoration re-evaluates trust (historical penalty is kept per the algorithm).
    await deps.onTrustEvent?.(
      publisherId,
      "LINK_RESTORED",
      `link restored on order ${order.id}`,
    )
    return { restored: true }
  }

  // ── Removal path: monitored VERIFIED link is gone ────────────────────────
  if (stillPresent) return { ok: true }

  const reason =
    "Link removed or changed after delivery (detected during settlement hold)"
  const upd = await prisma.orderDeliveryVersion.updateMany({
    where: { id: version.id, verificationVersion: version.verificationVersion },
    data: {
      verificationStatus: "FAILED",
      verificationFailureReason: reason,
      verificationVersion: version.verificationVersion + 1,
    },
  })
  if (upd.count === 0) return { skipped: "version_conflict" }

  const exists = await prisma.deliveryFraudFlag.findFirst({
    where: { deliveryVersionId: version.id, type: "LINK_REMOVED" },
    select: { id: true },
  })
  if (!exists) {
    await prisma.deliveryFraudFlag.create({
      data: {
        orderId: order.id,
        deliveryVersionId: version.id,
        type: "LINK_REMOVED",
        details: {
          detectedAt: now.toISOString(),
          publishedUrl: version.publishedUrl,
        },
      },
    })
  }
  await audit(prisma, "ORDER_DELIVERY_LINK_REMOVED", order, version, null, {
    reason,
    httpStatus: fetched.status,
  })

  const ownerIds = await publisherOwnerIds(prisma, publisherId)
  await notifyUsers(
    prisma,
    ownerIds,
    order.organizationId,
    "ORDER_DELIVERY_LINK_REMOVED",
    `The link for order ${order.id} is no longer live. Settlement is on hold until it is restored.`,
  )
  await notifyUsers(
    prisma,
    [order.customerId],
    order.organizationId,
    "ORDER_DELIVERY_LINK_REMOVED",
    `The placement for your order ${order.id} appears to have been removed. We've paused the publisher's payout and our team is reviewing.`,
  )
  await notifyUsers(
    prisma,
    await staffIds(prisma),
    null,
    "ORDER_DELIVERY_LINK_REMOVED",
    `Link removed on order ${order.id} during settlement hold — payout blocked.`,
  )

  // Settlement freeze (fraud flag) is intact; trust recompute is now triggered.
  await deps.onTrustEvent?.(
    publisherId,
    "LINK_REMOVED",
    `link removed on order ${order.id}`,
  )

  return { removed: true }
}

export interface HoldSweepResult {
  ok: boolean
  checked: number
  removed: number
  restored: number
}

// Re-checks the live link for every order whose payout is still on hold
// (settlement PENDING/UNDER_REVIEW). Run periodically by the worker.
export async function runSettlementHoldLinkSweep(
  deps: DeliveryDeps,
): Promise<HoldSweepResult> {
  const { prisma } = deps
  const held = await prisma.settlement.findMany({
    where: { status: { in: ["PENDING", "UNDER_REVIEW"] } },
    include: { order: { select: { activeDeliveryVersionId: true } } },
    take: 500,
  })

  let checked = 0
  let removed = 0
  let restored = 0
  for (const s of held) {
    const versionId = s.order?.activeDeliveryVersionId
    if (!versionId) continue
    const r = await runDeliveryLinkRecheck(deps, versionId)
    if (r.skipped === "not_verified" || r.skipped === "superseded") continue
    checked++
    if (r.removed) removed++
    if (r.restored) restored++
  }
  return { ok: true, checked, removed, restored }
}
