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
import { recordCommunicationOutbox } from "./communication-outbox-core"
import { runLockedOrderSerializableTransaction } from "./order-aggregate-lock"
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
  fetchedPageUrl: string,
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
        // Relative links navigate against the fetched document URL. Canonical
        // metadata is publisher-controlled and must never rewrite the target
        // users would actually follow.
        abs = new URL(href, fetchedPageUrl).toString()
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

interface FraudCandidate {
  type: string
  details: Record<string, unknown>
}

// Fraud heuristics are deliberately read-only. Candidates are persisted only
// inside the final Order-locked verification transaction, after the active
// delivery pointer and optimistic version have been revalidated. This keeps a
// slow fetch/parse from attaching a settlement hold to a delivery that was
// superseded while the worker was running.
async function detectFraudCandidates(
  deps: DeliveryDeps,
  order: any,
  version: any,
  analysis: { targetUrlMatched: boolean; anchorFound: boolean },
): Promise<FraudCandidate[]> {
  const { prisma } = deps
  const flags: FraudCandidate[] = []

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

  return flags
}

async function readActiveDeliveryForMutation(
  tx: any,
  orderId: string,
  deliveryVersionId: string,
  expectedVerificationVersion: number,
) {
  const [currentOrder, currentDelivery] = await Promise.all([
    tx.order.findUnique({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        version: true,
        activeDeliveryVersionId: true,
      },
    }),
    tx.orderDeliveryVersion.findUnique({
      where: { id: deliveryVersionId },
      select: {
        id: true,
        orderId: true,
        verificationStatus: true,
        interventionStatus: true,
        verificationVersion: true,
        supersededByVersion: true,
      },
    }),
  ])

  if (!currentOrder || !currentDelivery) return { state: "missing" as const }
  if (
    currentOrder.activeDeliveryVersionId !== deliveryVersionId ||
    currentDelivery.orderId !== orderId ||
    currentDelivery.supersededByVersion != null
  ) {
    return { state: "stale" as const }
  }
  if (currentDelivery.verificationVersion !== expectedVerificationVersion) {
    return { state: "version_conflict" as const }
  }
  return {
    state: "current" as const,
    order: currentOrder,
    delivery: currentDelivery,
  }
}

// Main entry. `isFinalAttempt` tells us to route transient failures to
// MANUAL_REVIEW instead of throwing for another retry.
export async function runDeliveryVerification(
  deps: DeliveryDeps,
  deliveryVersionId: string,
  opts: {
    expectedVerificationVersion: number
    actorUserId?: string
    isFinalAttempt?: boolean
  },
): Promise<DeliveryVerifyResult> {
  const { prisma, fetchUrl, putObject } = deps
  const now = (deps.now ?? (() => new Date()))()

  const version = await prisma.orderDeliveryVersion.findUnique({
    where: { id: deliveryVersionId },
  })
  if (!version) return { skipped: "not_found" }
  if (
    !Number.isSafeInteger(opts.expectedVerificationVersion) ||
    opts.expectedVerificationVersion < 0
  ) {
    return { skipped: "invalid_generation" }
  }
  if (version.verificationVersion !== opts.expectedVerificationVersion) {
    return { skipped: "stale_generation" }
  }
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

  // The signed job generation is immutable command evidence. Never adopt a
  // newer row generation after a preflight/reverify race.
  const expectedVersion = opts.expectedVerificationVersion

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
      const transition = await runLockedOrderSerializableTransaction(
        prisma,
        order.id,
        async (tx) => {
          const current = await readActiveDeliveryForMutation(
            tx,
            order.id,
            version.id,
            expectedVersion,
          )
          if (current.state !== "current") return current.state
          if (current.order.status !== "PUBLISHED") return "stale" as const
          const updated = await tx.orderDeliveryVersion.updateMany({
            where: {
              id: version.id,
              orderId: order.id,
              supersededByVersion: null,
              verificationVersion: expectedVersion,
            },
            data: { verificationStatus: "RETRYING" },
          })
          if (updated.count === 0) return "version_conflict" as const
          await audit(
            tx,
            "ORDER_DELIVERY_VERIFICATION_RETRIED",
            order,
            version,
            null,
            {
              httpStatus: fetched.status,
              error: fetched.error ?? null,
            },
          )
          return "committed" as const
        },
      )
      if (transition !== "committed") return { skipped: transition }
      throw new Error(
        `Delivery fetch failed (status ${fetched.status}${fetched.error ? `, ${fetched.error}` : ""}) — retrying`,
      )
    }
    // Exhausted retries → MANUAL_REVIEW (a human must look).
    const reason = fetched.error
      ? `Fetch error: ${fetched.error}`
      : `HTTP ${fetched.status} after redirects`
    const transition = await runLockedOrderSerializableTransaction(
      prisma,
      order.id,
      async (tx) => {
        const current = await readActiveDeliveryForMutation(
          tx,
          order.id,
          version.id,
          expectedVersion,
        )
        if (current.state !== "current") return current.state
        if (current.order.status !== "PUBLISHED") return "stale" as const
        const upd = await tx.orderDeliveryVersion.updateMany({
          where: {
            id: version.id,
            orderId: order.id,
            supersededByVersion: null,
            verificationVersion: expectedVersion,
          },
          data: {
            verificationStatus: "MANUAL_REVIEW",
            verificationFailureReason: reason,
            verificationVersion: expectedVersion + 1,
          },
        })
        if (upd.count === 0) return "version_conflict" as const
        await audit(tx, "ORDER_DELIVERY_ESCALATED", order, version, null, {
          reason,
          manualReview: true,
          httpStatus: fetched.status,
          error: fetched.error ?? null,
          redirectChain: fetched.redirectChain,
        })
        await tx.orderEvent.create({
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
        return "committed" as const
      },
    )
    if (transition !== "committed") return { skipped: transition }
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
    fetched.finalUrl,
    order.targetUrl ?? null,
    order.anchorText ?? null,
  )
  const htmlHash = createHash("sha256").update(fetched.html).digest("hex")

  // The object is uploaded before the database transaction because object
  // storage cannot participate in PostgreSQL commit. The key is immutable and
  // content addressed, so a retry can only overwrite identical bytes. A lost
  // database CAS may leave an unreferenced object for retention cleanup, but
  // never a misleading evidence row.
  const htmlKey = `deliveries/${version.id}/verification-${expectedVersion}-${htmlHash}.html`
  let snapshotStored = false
  let snapshotObjectKey: string | null = null
  let snapshotStorageError: string | null = null
  try {
    const stored = await putObject(
      htmlKey,
      fetched.html,
      "text/html; charset=utf-8",
    )
    if (stored.objectKey !== htmlKey) {
      throw new Error("object storage returned an unexpected snapshot key")
    }
    snapshotObjectKey = stored.objectKey
    snapshotStored = true
  } catch (err: any) {
    snapshotStorageError = err?.message ?? "snapshot storage failed"
    if (!opts.isFinalAttempt) {
      throw new Error(
        `Delivery snapshot storage failed (${snapshotStorageError}) — retrying`,
      )
    }
  }

  // ── Decide + transition (version-guarded) ───────────────────────────────────
  const checksPass =
    analysis.linkFound && analysis.targetUrlMatched && analysis.anchorFound
  // Permanent raw evidence is required before automation may advance an Order
  // toward settlement. Exhausted storage retries fail closed to manual review.
  // Detection can perform slow reads before the lock; no hold is persisted
  // until the active delivery is revalidated inside the transition below.
  const fraudCandidates = await detectFraudCandidates(
    deps,
    order,
    version,
    analysis,
  )
  const fraudTypes = fraudCandidates.map((flag) => flag.type)
  // A technically passing page is not an automatically verified delivery when
  // it also generated a fraud signal. Keep it in manual review until every
  // immutable hold has an explicit, separately audited adjudication.
  const requiresFraudReview =
    snapshotStored && checksPass && fraudTypes.length > 0
  const newStatus = snapshotStored
    ? checksPass && !requiresFraudReview
      ? "VERIFIED"
      : requiresFraudReview
        ? "MANUAL_REVIEW"
        : "FAILED"
    : "MANUAL_REVIEW"
  const failureReason = snapshotStorageError
    ? `Permanent delivery snapshot unavailable: ${snapshotStorageError}`
    : requiresFraudReview
      ? "Delivery requires staff fraud review"
      : checksPass
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

  let committedStatus = newStatus
  let committedFailureReason = failureReason
  let committedRequiresFraudReview = requiresFraudReview

  try {
    const transition = await runLockedOrderSerializableTransaction(
      prisma,
      order.id,
      async (tx) => {
        const current = await readActiveDeliveryForMutation(
          tx,
          order.id,
          version.id,
          expectedVersion,
        )
        if (current.state === "missing" || current.state === "stale") {
          return current.state
        }
        if (current.state === "version_conflict") {
          const conflict = new Error("delivery verification version conflict")
          conflict.name = "DeliveryVerificationVersionConflict"
          throw conflict
        }
        if (current.order.status !== "PUBLISHED") return "stale" as const

        const currentFraudHold =
          newStatus === "VERIFIED"
            ? await tx.deliveryFraudHold.findFirst({
                where: { orderId: order.id },
                select: { fraudFlagId: true },
              })
            : null
        const effectiveRequiresFraudReview =
          requiresFraudReview || currentFraudHold != null
        const effectiveStatus =
          newStatus === "VERIFIED" && effectiveRequiresFraudReview
            ? "MANUAL_REVIEW"
            : newStatus
        const effectiveFailureReason =
          effectiveStatus === "MANUAL_REVIEW" && effectiveRequiresFraudReview
            ? "Delivery requires staff fraud review"
            : failureReason
        const effectivePass = effectiveStatus === "VERIFIED"

        if (snapshotStored && snapshotObjectKey) {
          await tx.deliverySnapshot.create({
            data: {
              deliveryVersionId: version.id,
              htmlObjectKey: snapshotObjectKey,
              responseHeaders: fetched.headers as any,
            },
          })
        }
        await tx.deliveryVerificationEvidence.create({
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
        await audit(
          tx,
          "ORDER_DELIVERY_SNAPSHOT_CAPTURED",
          order,
          version,
          null,
          snapshotStored
            ? { htmlObjectKey: snapshotObjectKey, htmlHash }
            : { error: snapshotStorageError, htmlHash },
        )

        const upd = await tx.orderDeliveryVersion.updateMany({
          where: {
            id: version.id,
            orderId: order.id,
            supersededByVersion: null,
            verificationVersion: expectedVersion,
          },
          data: {
            verificationStatus: effectiveStatus,
            verificationFailureReason: effectiveFailureReason,
            verificationVersion: expectedVersion + 1,
          },
        })
        if (upd.count === 0) {
          const conflict = new Error("delivery verification version conflict")
          conflict.name = "DeliveryVerificationVersionConflict"
          throw conflict
        }

        let autoAcceptAt: Date | null = null
        if (effectivePass) {
          const reviewWindowMs =
            defaultWorkflowConfig.reviewWindowDays * 24 * 60 * 60 * 1000
          autoAcceptAt = new Date(now.getTime() + reviewWindowMs)
          const orderUpdate = await tx.order.updateMany({
            where: {
              id: order.id,
              status: "PUBLISHED",
              version: current.order.version,
            },
            data: {
              status: "VERIFIED",
              verifiedAt: now,
              verifiedBy: null,
              verifyMethod: "AUTO",
              autoAcceptAt,
              version: { increment: 1 },
            },
          })
          if (orderUpdate.count === 0) {
            const conflict = new Error("order verification version conflict")
            conflict.name = "DeliveryVerificationVersionConflict"
            throw conflict
          }
        }

        const createdFraudFlags: Array<{ id: string; type: string }> = []
        for (const flag of fraudCandidates) {
          // The Order lock serializes this check+insert. The database unique
          // constraint remains the final guard for non-cooperating clients.
          const exists = await tx.deliveryFraudFlag.findFirst({
            where: {
              deliveryVersionId: version.id,
              type: flag.type,
              resolution: null,
            },
            select: { id: true },
          })
          if (exists) continue
          const createdFlag = await tx.deliveryFraudFlag.create({
            data: {
              orderId: order.id,
              deliveryVersionId: version.id,
              type: flag.type,
              details: flag.details,
            },
          })
          createdFraudFlags.push({ id: createdFlag.id, type: flag.type })
          await audit(
            tx,
            "ORDER_DELIVERY_FRAUD_FLAGGED",
            order,
            version,
            null,
            { fraudType: flag.type, details: flag.details },
          )
        }
        if (createdFraudFlags.length > 0) {
          const staff = await tx.staffMembership.findMany({
            where: {
              role: { in: ["SUPER_ADMIN", "OPERATIONS", "FINANCE"] },
              user: { banned: false },
            },
            select: { userId: true },
          })
          await recordCommunicationOutbox(tx, {
            type: "STAFF_FRAUD_ALERT",
            aggregateType: "Order",
            aggregateId: order.id,
            organizationId: null,
            title: "Delivery fraud review required",
            message: `Order ${order.id} generated delivery fraud signals: ${createdFraudFlags.map((flag) => flag.type).join(", ")}.`,
            actionPath: "/dashboard/verification/delivery",
            payload: {
              deliveryVersionId: version.id,
              fraudFlags: createdFraudFlags,
            },
            dedupKey: `order:${order.id}:delivery:${version.id}:fraud-generation:${expectedVersion}`,
            recipientUserIds: staff.map(
              (membership: { userId: string }) => membership.userId,
            ),
          })
        }

        await tx.orderEvent.create({
          data: {
            orderId: order.id,
            eventType: effectivePass
              ? "VERIFIED_AUTO"
              : "VERIFICATION_ESCALATED",
            actorId: null,
            message: effectivePass
              ? `Delivery auto-verified; review window expires ${autoAcceptAt?.toISOString()}`
              : effectiveStatus === "MANUAL_REVIEW"
                ? "Delivery verification requires manual evidence review"
                : "Delivery verification failed and requires attention",
            metadata: {
              httpStatus: fetched.status,
              resolvedUrl: fetched.finalUrl,
              targetUrlMatched: analysis.targetUrlMatched,
              anchorFound: analysis.anchorFound,
              htmlHash,
              snapshotStored,
              fraudTypes,
              reason: effectiveFailureReason,
            },
          },
        })
        await audit(
          tx,
          effectivePass
            ? "ORDER_DELIVERY_AUTO_VERIFIED"
            : effectiveStatus === "MANUAL_REVIEW"
              ? "ORDER_DELIVERY_ESCALATED"
              : "ORDER_DELIVERY_AUTO_FAILED",
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
            reason: effectiveFailureReason,
          },
        )
        return {
          state: "committed" as const,
          status: effectiveStatus,
          failureReason: effectiveFailureReason,
          requiresFraudReview: effectiveRequiresFraudReview,
        }
      },
    )
    if (typeof transition === "string") return { skipped: transition }
    committedStatus = transition.status
    committedFailureReason = transition.failureReason
    committedRequiresFraudReview = transition.requiresFraudReview
  } catch (error) {
    if (
      error instanceof Error &&
      error.name === "DeliveryVerificationVersionConflict"
    ) {
      // A concurrent order or delivery transition means this verification did
      // not commit. Propagate the conflict so BullMQ retries the job instead
      // of recording a successful-but-skipped completion that could leave the
      // delivery stuck in PENDING/RETRYING indefinitely.
      throw error
    }
    throw error
  }

  // Notifications are intentionally after commit. They are retryable side
  // effects and must never make an order/event transaction roll back.
  const ownerIds = await publisherOwnerIds(prisma, order.website?.publisherId)
  if (committedStatus === "VERIFIED") {
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
  } else if (committedStatus === "MANUAL_REVIEW") {
    if (!committedRequiresFraudReview) {
      await notifyUsers(
        prisma,
        await staffIds(prisma),
        null,
        "ORDER_DELIVERY_MANUAL_REVIEW",
        `Delivery for order ${order.id} needs manual evidence review: ${committedFailureReason}.`,
      )
    }
    await notifyUsers(
      prisma,
      ownerIds,
      order.organizationId,
      "ORDER_DELIVERY_MANUAL_REVIEW",
      `Your delivery for order ${order.id} is awaiting manual evidence review.`,
    )
  } else {
    await notifyUsers(
      prisma,
      ownerIds,
      order.organizationId,
      "ORDER_DELIVERY_FAILED",
      `Delivery verification failed for order ${order.id}: ${committedFailureReason}.`,
    )
    await notifyUsers(
      prisma,
      [order.customerId],
      order.organizationId,
      "ORDER_VERIFICATION_FAILED",
      `Your order ${order.id} delivery could not be verified.`,
    )
  }

  return {
    status: committedStatus,
    reason: committedFailureReason ?? undefined,
  }
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
          where: {
            deliveryVersionId: version.id,
            type: "LINK_REMOVED",
            resolution: null,
          },
          select: { id: true },
        })
      : null
  const manuallyApproved = version.interventionStatus === "APPROVED"
  if (
    version.verificationStatus !== "VERIFIED" &&
    !manuallyApproved &&
    !hadRemovalFlag
  )
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
    fetched.finalUrl,
    order.targetUrl ?? null,
    order.anchorText ?? null,
  )
  const htmlHash = createHash("sha256").update(fetched.html).digest("hex")
  const stillPresent =
    analysis.linkFound && analysis.targetUrlMatched && analysis.anchorFound

  // ── Restoration path: a previously-removed link is back ──────────────────
  if (hadRemovalFlag) {
    if (!stillPresent) return { ok: true } // still gone
    const committed = await runLockedOrderSerializableTransaction(
      prisma,
      order.id,
      async (tx) => {
        const current = await readActiveDeliveryForMutation(
          tx,
          order.id,
          version.id,
          version.verificationVersion,
        )
        if (current.state !== "current") return false
        const currentRemovalFlag = await tx.deliveryFraudFlag.findFirst({
          where: {
            deliveryVersionId: version.id,
            type: "LINK_REMOVED",
            resolution: null,
          },
          select: { id: true, createdAt: true },
        })
        if (!currentRemovalFlag) return false
        const flagCreatedAt = new Date(
          currentRemovalFlag.createdAt ?? now.getTime() - 1,
        ).getTime()
        const checkedAt = new Date(
          Math.max(
            now.getTime(),
            Number.isFinite(flagCreatedAt) ? flagCreatedAt + 1 : now.getTime(),
          ),
        )
        const verificationEvidence =
          await tx.deliveryVerificationEvidence.create({
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
              checkedAt,
            },
          })
        const upd = await tx.orderDeliveryVersion.updateMany({
          where: {
            id: version.id,
            orderId: order.id,
            supersededByVersion: null,
            verificationVersion: version.verificationVersion,
          },
          data: {
            verificationStatus: "VERIFIED",
            interventionStatus: "NONE",
            verificationFailureReason: null,
            verificationVersion: version.verificationVersion + 1,
          },
        })
        if (upd.count === 0) return false
        const resolution = await tx.deliveryFraudFlagResolution.create({
          data: {
            fraudFlagId: currentRemovalFlag.id,
            orderId: order.id,
            deliveryVersionId: version.id,
            kind: "LINK_RESTORED",
            reason:
              "Automated settlement-hold recheck confirmed the required live link was restored.",
            resolvedByUserId: null,
            resolvedByRole: null,
            evidenceId: verificationEvidence.id,
            evidence: {
              checkedAt: checkedAt.toISOString(),
              httpStatus: fetched.status,
              resolvedUrl: fetched.finalUrl,
              htmlHash,
            },
          },
        })
        await audit(tx, "ORDER_DELIVERY_LINK_RESTORED", order, version, null, {
          httpStatus: fetched.status,
          fraudFlagId: currentRemovalFlag.id,
          fraudResolutionId: resolution.id,
          verificationEvidenceId: verificationEvidence.id,
        })
        return true
      },
    )
    if (!committed) return { skipped: "version_conflict" }
    await notifyUsers(
      prisma,
      await staffIds(prisma),
      null,
      "ORDER_DELIVERY_LINK_RESTORED",
      `Link restored on order ${order.id}; the automated LINK_REMOVED hold was resolved with fresh evidence.`,
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
  if (stillPresent) {
    const committed = await runLockedOrderSerializableTransaction(
      prisma,
      order.id,
      async (tx) => {
        const current = await readActiveDeliveryForMutation(
          tx,
          order.id,
          version.id,
          version.verificationVersion,
        )
        if (current.state !== "current") return false
        if (
          current.delivery.verificationStatus !== "VERIFIED" &&
          current.delivery.interventionStatus !== "APPROVED"
        ) {
          return false
        }
        const evidence = await tx.deliveryVerificationEvidence.create({
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
        await audit(
          tx,
          "ORDER_DELIVERY_LINK_RECHECK_PASSED",
          order,
          version,
          null,
          {
            httpStatus: fetched.status,
            verificationEvidenceId: evidence.id,
          },
        )
        return true
      },
    )
    return committed ? { ok: true } : { skipped: "version_conflict" }
  }

  const reason =
    "Link removed or changed after delivery (detected during settlement hold)"
  const committed = await runLockedOrderSerializableTransaction(
    prisma,
    order.id,
    async (tx) => {
      const current = await readActiveDeliveryForMutation(
        tx,
        order.id,
        version.id,
        version.verificationVersion,
      )
      if (current.state !== "current") return false
      if (
        current.delivery.verificationStatus !== "VERIFIED" &&
        current.delivery.interventionStatus !== "APPROVED"
      ) {
        return false
      }
      const verificationEvidence = await tx.deliveryVerificationEvidence.create(
        {
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
        },
      )
      const upd = await tx.orderDeliveryVersion.updateMany({
        where: {
          id: version.id,
          orderId: order.id,
          supersededByVersion: null,
          verificationVersion: version.verificationVersion,
        },
        data: {
          verificationStatus: "FAILED",
          interventionStatus: "REJECTED",
          verificationFailureReason: reason,
          verificationVersion: version.verificationVersion + 1,
        },
      })
      if (upd.count === 0) return false

      const exists = await tx.deliveryFraudFlag.findFirst({
        where: {
          deliveryVersionId: version.id,
          type: "LINK_REMOVED",
          resolution: null,
        },
        select: { id: true },
      })
      if (!exists) {
        await tx.deliveryFraudFlag.create({
          data: {
            orderId: order.id,
            deliveryVersionId: version.id,
            type: "LINK_REMOVED",
            details: {
              detectedAt: now.toISOString(),
              publishedUrl: version.publishedUrl,
              verificationEvidenceId: verificationEvidence.id,
            },
          },
        })
      }
      await audit(tx, "ORDER_DELIVERY_LINK_REMOVED", order, version, null, {
        reason,
        httpStatus: fetched.status,
        verificationEvidenceId: verificationEvidence.id,
      })
      return true
    },
  )
  if (!committed) return { skipped: "version_conflict" }

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
  scanned: number
  checked: number
  removed: number
  restored: number
  failed: number
  scanCapReached: boolean
  oldestUncheckedCreatedAt: Date | null
}

const HOLD_SWEEP_PAGE_SIZE = 100
const HOLD_SWEEP_SCAN_CAP = 5_000
const HOLD_SWEEP_CONCURRENCY = 5
const UNRELEASED_SETTLEMENT_STATUSES = [
  "PENDING",
  "UNDER_REVIEW",
  "CUSTOMER_APPROVED",
  "ADMIN_APPROVED",
] as const

// Re-check every unreleased settlement deterministically. Cursor pagination
// prevents the same first 500 rows from starving newer holds; bounded batches
// cap worker load while fetchWithChain supplies the per-request timeout.
export async function runSettlementHoldLinkSweep(
  deps: DeliveryDeps,
): Promise<HoldSweepResult> {
  const { prisma } = deps
  let scanned = 0
  let checked = 0
  let removed = 0
  let restored = 0
  let failed = 0
  let cursorId: string | null = null
  let lastPageWasFull = false

  while (scanned < HOLD_SWEEP_SCAN_CAP) {
    const take = Math.min(HOLD_SWEEP_PAGE_SIZE, HOLD_SWEEP_SCAN_CAP - scanned)
    const held: Array<{
      id: string
      createdAt: Date
      order?: { activeDeliveryVersionId?: string | null } | null
    }> = await prisma.settlement.findMany({
      where: { status: { in: [...UNRELEASED_SETTLEMENT_STATUSES] } },
      include: { order: { select: { activeDeliveryVersionId: true } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      take,
    })
    if (held.length === 0) {
      lastPageWasFull = false
      break
    }
    scanned += held.length
    cursorId = held[held.length - 1].id
    lastPageWasFull = held.length === take

    for (
      let offset = 0;
      offset < held.length;
      offset += HOLD_SWEEP_CONCURRENCY
    ) {
      const batch = held.slice(offset, offset + HOLD_SWEEP_CONCURRENCY)
      const results = await Promise.allSettled(
        batch.map(async (settlement: any) => {
          const versionId = settlement.order?.activeDeliveryVersionId
          return versionId
            ? runDeliveryLinkRecheck(deps, versionId)
            : ({ skipped: "no_active_delivery" } as LinkRecheckResult)
        }),
      )
      for (const result of results) {
        if (result.status === "rejected") {
          failed++
          continue
        }
        const recheck = result.value
        if (
          recheck.skipped === "not_verified" ||
          recheck.skipped === "superseded" ||
          recheck.skipped === "no_active_delivery"
        ) {
          continue
        }
        checked++
        if (recheck.removed) removed++
        if (recheck.restored) restored++
      }
    }
    if (held.length < take) break
  }

  const scanCapReached =
    scanned >= HOLD_SWEEP_SCAN_CAP && lastPageWasFull && cursorId != null
  const oldestUnchecked = scanCapReached
    ? await prisma.settlement.findMany({
        where: { status: { in: [...UNRELEASED_SETTLEMENT_STATUSES] } },
        select: { createdAt: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        cursor: { id: cursorId },
        skip: 1,
        take: 1,
      })
    : []

  return {
    ok: failed === 0,
    scanned,
    checked,
    removed,
    restored,
    failed,
    scanCapReached: scanCapReached && oldestUnchecked.length > 0,
    oldestUncheckedCreatedAt: oldestUnchecked[0]?.createdAt ?? null,
  }
}
