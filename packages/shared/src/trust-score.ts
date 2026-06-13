// Internal website trust score (0–100) for moderation staff. Uses ONLY internal
// platform signals — no external SEO/traffic/DR providers. Pure + deterministic
// so it is unit-testable and reproducible. Raw score is never exposed publicly;
// surface only the band (Low/Medium/High).

export interface TrustScoreInputs {
  verificationStatus: string
  verifiedAt?: Date | string | null
  now?: Date
  verificationCheckCount: number
  consecutiveFailures: number
  revocationCount: number // historical REVOKED audit events
  listingCount: number
  completedOrderCount: number
  totalOrderCount: number
  disputeCount: number
  refundCount: number
  chargebackCount: number
}

export interface TrustScore {
  score: number
  band: "Low" | "Medium" | "High"
}

function clamp(n: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, n))
}

export function computeTrustScore(input: TrustScoreInputs): TrustScore {
  const now = input.now ?? new Date()

  // Hard gates: unverified/revoked domains are inherently low trust.
  if (input.verificationStatus === "REVOKED") return { score: 0, band: "Low" }
  if (input.verificationStatus !== "VERIFIED") return { score: clamp(20 - input.consecutiveFailures * 5, 0, 40), band: "Low" }

  let score = 50 // verified baseline

  // Verification age — older proven ownership is more trustworthy (cap +20 at 1y)
  if (input.verifiedAt) {
    const ageDays = (now.getTime() - new Date(input.verifiedAt).getTime()) / 86_400_000
    score += clamp(Math.floor(ageDays / 18), 0, 20)
  }

  // Verification stability — successful health checks add, recent failures hurt
  score += clamp(input.verificationCheckCount, 0, 10)
  score -= input.consecutiveFailures * 5
  score -= clamp(input.revocationCount * 8, 0, 24)

  // Marketplace history
  score += clamp(input.listingCount * 2, 0, 6)
  score += clamp(Math.floor(input.completedOrderCount / 2), 0, 20)

  // Quality penalties — rates over the order base
  const base = Math.max(input.totalOrderCount, 1)
  const disputeRate = input.disputeCount / base
  const refundRate = input.refundCount / base
  score -= Math.round(disputeRate * 40)
  score -= Math.round(refundRate * 30)
  score -= input.chargebackCount * 10 // chargebacks are severe

  const final = clamp(Math.round(score), 0, 100)
  const band: TrustScore["band"] = final >= 70 ? "High" : final >= 40 ? "Medium" : "Low"
  return { score: final, band }
}

export function trustBand(score: number | null | undefined): "Low" | "Medium" | "High" | "Unknown" {
  if (score == null) return "Unknown"
  return score >= 70 ? "High" : score >= 40 ? "Medium" : "Low"
}

// ── Publisher-level trust ───────────────────────────────────────────────────
// Aggregate trust across a publisher's whole track record. Internal signals
// only. Drives the publisher tier (NEW / TRUSTED / VERIFIED) shown in the
// marketplace and used by moderation.
export interface PublisherTrustInputs {
  avgRating: number | null       // 1..5 from order reviews
  reviewCount: number
  completedOrders: number
  totalOrders: number
  disputeCount: number
  refundCount: number
  linkRemovals: number           // LINK_REMOVED fraud flags across their orders
  websiteRevocations: number     // REVOKED websites (lost domain verification)
}

export interface PublisherTrust {
  score: number
  band: "Low" | "Medium" | "High"
  tier: "NEW" | "TRUSTED" | "VERIFIED"
}

export function computePublisherTrust(input: PublisherTrustInputs): PublisherTrust {
  // New publishers with no track record start neutral-low (must earn trust).
  if (input.totalOrders === 0 && input.reviewCount === 0) {
    return { score: 30, band: "Low", tier: "NEW" }
  }

  let score = 45 // baseline once they have history

  // Review quality (1..5 -> up to +25)
  if (input.avgRating != null && input.reviewCount > 0) {
    score += clamp(((input.avgRating - 3) / 2) * 25, -25, 25)
    score += clamp(input.reviewCount, 0, 5) // a little for volume of feedback
  }

  // Reliable completion
  const base = Math.max(input.totalOrders, 1)
  const completionRate = input.completedOrders / base
  score += clamp(Math.round(completionRate * 20), 0, 20)
  score += clamp(Math.floor(input.completedOrders / 3), 0, 10) // proven volume

  // Penalties — rates over the order base, plus hard hits for trust violations
  score -= Math.round((input.disputeCount / base) * 30)
  score -= Math.round((input.refundCount / base) * 25)
  // Removing a delivered link is the worst trust violation on this platform.
  score -= input.linkRemovals * 12
  score -= input.websiteRevocations * 8

  const final = clamp(Math.round(score), 0, 100)
  const band: PublisherTrust["band"] = final >= 70 ? "High" : final >= 40 ? "Medium" : "Low"
  // Tier ladder — VERIFIED requires sustained high trust + real volume.
  const tier: PublisherTrust["tier"] =
    final >= 80 && input.completedOrders >= 5 && input.linkRemovals === 0
      ? "VERIFIED"
      : final >= 55
      ? "TRUSTED"
      : "NEW"
  return { score: final, band, tier }
}
