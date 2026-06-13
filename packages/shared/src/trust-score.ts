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
