import type { SettlementCustomerHistory } from "./settlement-risk"
import { defaultWorkflowConfig, WorkflowConfig } from "./workflow-config"

export interface PriorityScore {
  score: number
  label: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW"
}

export interface RiskLevel {
  level: "LOW" | "MEDIUM" | "HIGH"
  factors: string[]
}

export class WorkflowDecisionService {
  constructor(private config: WorkflowConfig = defaultWorkflowConfig) {}

  computeVerificationPriority(
    _order: {
      amount?: number | null
      customer?: { isEnterprise?: boolean } | null
    },
    _publisher: { tier?: string; isVip?: boolean } | null,
    queueTimeMs: number,
  ): PriorityScore {
    let score = 0

    if (_order?.customer?.isEnterprise) score += 50
    if (_publisher?.isVip) score += 30
    if (Number(_order?.amount ?? 0) > this.config.autoReleaseMaxAmount)
      score += 20
    const queueHours = queueTimeMs / (60 * 60 * 1000)
    score += Math.floor(queueHours / 12) * 15
    if (_publisher?.tier === "TRUSTED") score += 5

    const label =
      score > 80
        ? "CRITICAL"
        : score > 50
          ? "HIGH"
          : score > 20
            ? "MEDIUM"
            : "LOW"
    return { score, label }
  }

  computeSettlementReleasePolicy(
    order: { verifyMethod?: string | null; amount?: number | null },
    publisher: { tier?: string; riskScore?: number } | null,
    fraudFlags: { type: string }[],
    customerHistory?: SettlementCustomerHistory | null,
  ): "AUTO" | "MANUAL" {
    if (order.verifyMethod === "MANUAL_ADMIN") return "MANUAL"
    if (fraudFlags.length > 0) return "MANUAL"

    // Risk classification and the operational auto-release switch are
    // deliberately orthogonal. The switch controls whether an AUTO policy can
    // execute; it must never turn a high-risk policy into AUTO when enabled.
    if (!publisher || !["TRUSTED", "VERIFIED"].includes(publisher.tier ?? ""))
      return "MANUAL"

    const amount = Number(order.amount)
    if (!Number.isFinite(amount) || amount <= 0) return "MANUAL"
    if (amount > this.config.autoReleaseMaxAmount) return "MANUAL"

    // Missing history is unknown evidence, not proof of a clean customer.
    if (!customerHistory) return "MANUAL"
    if (
      !Number.isSafeInteger(customerHistory.chargebackCount) ||
      customerHistory.chargebackCount < 0 ||
      !Number.isSafeInteger(customerHistory.disputeCount) ||
      customerHistory.disputeCount < 0
    )
      return "MANUAL"
    if (customerHistory.chargebackCount > 0) return "MANUAL"

    return "AUTO"
  }

  computeReviewWindowDays(_publisher?: { tier?: string } | null): number {
    return this.config.reviewWindowDays
  }

  computeAutoReleaseEligibility(_settlement: {
    releasePolicy?: string
  }): boolean {
    return _settlement.releasePolicy === "AUTO" && this.config.enableAutoRelease
  }

  computeRiskLevel(
    _order: { amount?: number | null },
    _publisher?: { tier?: string; riskScore?: number } | null,
    _customerHistory?: { chargebackCount: number; disputeCount: number } | null,
  ): RiskLevel {
    const factors: string[] = []

    if (Number(_order.amount ?? 0) > this.config.autoReleaseMaxAmount)
      factors.push("high-order-amount")
    if (_publisher?.tier === "NEW") factors.push("new-publisher")
    if ((_customerHistory?.chargebackCount ?? 0) > 0)
      factors.push("customer-chargeback-history")
    if ((_customerHistory?.disputeCount ?? 0) > 0)
      factors.push("customer-dispute-history")

    const level =
      factors.length > 1 ? "HIGH" : factors.length === 1 ? "MEDIUM" : "LOW"
    return { level, factors }
  }
}
