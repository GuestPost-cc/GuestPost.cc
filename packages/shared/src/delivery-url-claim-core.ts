/**
 * Cross-order delivery URL claim serialization and freshness checks.
 *
 * Lock ordering is part of the security boundary: callers must lock the
 * canonical Order row first, then acquire this normalized-URL advisory lock.
 * Every runtime claim writer and every delivery/settlement authorization path
 * follows that order so a URL claim cannot appear between evidence validation
 * and the protected transition.
 */

import { recordCommunicationOutbox } from "./communication-outbox-core"

const CLAIM_FINGERPRINT_SAMPLE_LIMIT = 128

export type DeliveryUrlReuseFreshnessSource =
  | "CUSTOMER_CONFIRM"
  | "CUSTOMER_MANUAL_ACCEPT"
  | "AUTO_ACCEPT"
  | "SETTLEMENT_ELIGIBILITY"

export interface DeliveryUrlReuseCandidate {
  type: "URL_REUSED"
  details: {
    otherOrderId: string
    otherVersionId: string
    reuseCount: number
    claimFingerprintVersion: 1
    claimFingerprint: string
  }
}

export interface DeliveryUrlReuseFreshnessResult {
  requiresReview: boolean
  createdFlagId: string | null
  activeFlagId: string | null
  candidate: DeliveryUrlReuseCandidate | null
  communicationEventId: string | null
  communicationDedupKey: string | null
}

type ClassifiedFraudDisposition =
  | "FALSE_POSITIVE"
  | "AUTHORIZED_REUSE"
  | "RISK_ACCEPTED"

const CLASSIFIED_FRAUD_DISPOSITIONS = new Set<ClassifiedFraudDisposition>([
  "FALSE_POSITIVE",
  "AUTHORIZED_REUSE",
  "RISK_ACCEPTED",
])

function canonicalJson(value: unknown): string {
  const stable = (entry: unknown): string => {
    if (entry === null || typeof entry !== "object") {
      return JSON.stringify(entry)
    }
    if (Array.isArray(entry)) return `[${entry.map(stable).join(",")}]`
    return `{${Object.entries(entry as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => `${JSON.stringify(key)}:${stable(child)}`)
      .join(",")}}`
  }
  return stable(value ?? null)
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  )
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
}

/**
 * Transaction-scoped lock and MVCC fence for one normalized URL. The database
 * function takes the shared advisory key and locks a backfilled per-URL row.
 * The row lock makes a SERIALIZABLE waiter abort/retry when a claim committed
 * after its snapshot, rather than reading stale predicate evidence.
 */
export async function lockDeliveryUrlClaim(
  tx: any,
  normalizedUrl: string,
): Promise<void> {
  if (typeof normalizedUrl !== "string" || normalizedUrl.length === 0) {
    throw new Error("Delivery URL claim lock requires a normalized URL")
  }
  await tx.$queryRaw`
    SELECT "acquire_delivery_url_claim_fence"(${normalizedUrl})
  `
}

/**
 * Builds deterministic, immutable evidence for every other delivery version
 * claiming the same normalized URL. The bounded identity sample prevents an
 * attacker-controlled hot URL from creating unbounded JSON; the exact total
 * count still makes every append-only new claim change the fingerprint.
 *
 * A caller making an authorization decision must hold lockDeliveryUrlClaim.
 */
export async function buildDeliveryUrlReuseCandidate(
  db: any,
  input: { orderId: string; normalizedUrl: string },
): Promise<DeliveryUrlReuseCandidate | null> {
  const where = {
    normalizedUrl: input.normalizedUrl,
    orderId: { not: input.orderId },
  }
  const [sample, reuseCount] = await Promise.all([
    db.orderDeliveryVersion.findMany({
      where,
      select: { id: true, orderId: true },
      orderBy: { id: "asc" },
      take: CLAIM_FINGERPRINT_SAMPLE_LIMIT,
    }),
    db.orderDeliveryVersion.count({ where }),
  ])

  if (!Number.isSafeInteger(reuseCount) || reuseCount < 0) {
    throw new Error("Delivery URL reuse count is invalid")
  }
  if (reuseCount === 0) return null
  if (
    !Array.isArray(sample) ||
    sample.length === 0 ||
    sample.length > reuseCount
  ) {
    throw new Error("Delivery URL reuse evidence is inconsistent")
  }

  const claims = sample.map((claim: { id: string; orderId: string }) => ({
    orderId: claim.orderId,
    deliveryVersionId: claim.id,
  }))
  const first = claims[0]
  if (!first?.orderId || !first.deliveryVersionId) {
    throw new Error("Delivery URL reuse evidence is incomplete")
  }
  const claimFingerprint = await sha256Hex(
    canonicalJson({
      version: 1,
      reuseCount,
      sampledClaims: claims,
      sampleTruncated: reuseCount > claims.length,
    }),
  )
  return {
    type: "URL_REUSED",
    details: {
      otherOrderId: first.orderId,
      otherVersionId: first.deliveryVersionId,
      reuseCount,
      claimFingerprintVersion: 1,
      claimFingerprint,
    },
  }
}

export function deliveryUrlReuseEvidenceMatches(
  persisted: unknown,
  candidate: DeliveryUrlReuseCandidate,
): boolean {
  if (!persisted || typeof persisted !== "object" || Array.isArray(persisted)) {
    return false
  }
  const details = persisted as Record<string, unknown>
  if (Object.hasOwn(details, "claimFingerprint")) {
    return canonicalJson(details) === canonicalJson(candidate.details)
  }

  // Explicit compatibility for adjudications created before the claim-set
  // fingerprint existed. Delivery versions are append-only, so the historical
  // first claimant plus exact count remains stable; any new claimant changes
  // reuseCount and forces a fresh review.
  return (
    Object.keys(details).sort().join(",") ===
      "otherOrderId,otherVersionId,reuseCount" &&
    details.otherOrderId === candidate.details.otherOrderId &&
    details.otherVersionId === candidate.details.otherVersionId &&
    details.reuseCount === candidate.details.reuseCount
  )
}

function classifiedUrlReuseDisposition(
  resolution: any,
  deliveryVersionId: string,
): ClassifiedFraudDisposition | null {
  if (resolution?.kind !== "STAFF_CLEARED") return null
  const evidence = resolution.evidence
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return null
  }
  const disposition = evidence.disposition as ClassifiedFraudDisposition
  if (
    !CLASSIFIED_FRAUD_DISPOSITIONS.has(disposition) ||
    typeof resolution.resolvedByUserId !== "string" ||
    resolution.resolvedByUserId.length === 0 ||
    evidence.fraudType !== "URL_REUSED" ||
    evidence.adjudicatedDeliveryVersionId !== deliveryVersionId ||
    evidence.roleAtTime !== resolution.resolvedByRole
  ) {
    return null
  }
  const reference = evidence.evidenceReference
  if (
    reference !== null &&
    reference !== undefined &&
    (typeof reference !== "string" ||
      reference.trim().length === 0 ||
      reference.length > 200)
  ) {
    return null
  }
  if (disposition === "AUTHORIZED_REUSE" || disposition === "RISK_ACCEPTED") {
    if (
      (resolution.resolvedByRole !== "FINANCE" &&
        resolution.resolvedByRole !== "SUPER_ADMIN") ||
      typeof reference !== "string" ||
      reference.trim().length === 0 ||
      reference.length > 200
    ) {
      return null
    }
  } else if (
    resolution.resolvedByRole !== "OPERATIONS" &&
    resolution.resolvedByRole !== "FINANCE" &&
    resolution.resolvedByRole !== "SUPER_ADMIN"
  ) {
    return null
  }
  return disposition
}

/**
 * Recomputes URL-reuse evidence while holding the shared URL lock. Exact,
 * classified staff evidence remains reusable. A changed claim set creates a
 * new immutable URL_REUSED flag; the database trigger projects its hold in the
 * same transaction.
 */
export async function refreshDeliveryUrlReuseEvidenceUnderLock(
  tx: any,
  input: {
    orderId: string
    deliveryVersionId: string
    normalizedUrl: string
    organizationId: string | null
    actorUserId?: string | null
    source: DeliveryUrlReuseFreshnessSource
  },
): Promise<DeliveryUrlReuseFreshnessResult> {
  await lockDeliveryUrlClaim(tx, input.normalizedUrl)
  const candidate = await buildDeliveryUrlReuseCandidate(tx, input)
  const history = await tx.deliveryFraudFlag.findMany({
    where: { deliveryVersionId: input.deliveryVersionId, type: "URL_REUSED" },
    select: {
      id: true,
      details: true,
      resolution: {
        select: {
          kind: true,
          resolvedByUserId: true,
          resolvedByRole: true,
          evidence: true,
        },
      },
    },
  })
  const unresolved = history.find((flag: any) => flag.resolution == null)
  if (unresolved) {
    return {
      requiresReview: true,
      createdFlagId: null,
      activeFlagId: unresolved.id,
      candidate,
      communicationEventId: null,
      communicationDedupKey: null,
    }
  }
  if (!candidate) {
    return {
      requiresReview: false,
      createdFlagId: null,
      activeFlagId: null,
      candidate: null,
      communicationEventId: null,
      communicationDedupKey: null,
    }
  }

  const classifiedMatch = history.find(
    (flag: any) =>
      deliveryUrlReuseEvidenceMatches(flag.details, candidate) &&
      classifiedUrlReuseDisposition(
        flag.resolution,
        input.deliveryVersionId,
      ) !== null,
  )
  if (classifiedMatch) {
    return {
      requiresReview: false,
      createdFlagId: null,
      activeFlagId: null,
      candidate,
      communicationEventId: null,
      communicationDedupKey: null,
    }
  }

  const created = await tx.deliveryFraudFlag.create({
    data: {
      orderId: input.orderId,
      deliveryVersionId: input.deliveryVersionId,
      type: candidate.type,
      details: candidate.details,
    },
    select: { id: true },
  })
  await tx.auditLog.create({
    data: {
      action: "ORDER_DELIVERY_URL_REUSE_FRESHNESS_FLAGGED",
      entityType: "OrderDeliveryVersion",
      entityId: input.deliveryVersionId,
      metadata: {
        orderId: input.orderId,
        deliveryVersionId: input.deliveryVersionId,
        fraudFlagId: created.id,
        fraudType: candidate.type,
        source: input.source,
        details: candidate.details,
      },
      userId: input.actorUserId ?? null,
      organizationId: input.organizationId,
    },
  })
  const staff = await tx.staffMembership.findMany({
    where: {
      role: { in: ["SUPER_ADMIN", "OPERATIONS", "FINANCE"] },
      user: { banned: false },
    },
    select: { userId: true },
  })
  // The history generation and evidence digest are stable across a manually
  // retried SERIALIZABLE transaction. Do not capture the created row id in a
  // post-commit wake key: an aborted attempt may have allocated a different
  // id from the committed retry.
  const communicationDedupKey = `order:${input.orderId}:delivery:${input.deliveryVersionId}:url-reuse:${history.length}:${candidate.details.claimFingerprint}`
  const communication = await recordCommunicationOutbox(tx, {
    type: "STAFF_FRAUD_ALERT",
    aggregateType: "Order",
    aggregateId: input.orderId,
    organizationId: null,
    title: "Delivery fraud review required",
    message: `Order ${input.orderId} has new URL-reuse evidence and requires review.`,
    actionPath: "/dashboard/verification/delivery",
    payload: {
      deliveryVersionId: input.deliveryVersionId,
      fraudFlags: [{ id: created.id, type: candidate.type }],
    },
    dedupKey: communicationDedupKey,
    recipientUserIds: staff.map(
      (membership: { userId: string }) => membership.userId,
    ),
  })
  return {
    requiresReview: true,
    createdFlagId: created.id,
    activeFlagId: created.id,
    candidate,
    communicationEventId: communication.eventId,
    communicationDedupKey,
  }
}
