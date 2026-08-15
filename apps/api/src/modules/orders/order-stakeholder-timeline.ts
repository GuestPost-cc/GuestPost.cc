export type OrderStakeholderTimelineViewer =
  | "CUSTOMER"
  | "PUBLISHER"
  | "OPERATIONS"
  | "FINANCE"
  | "SUPER_ADMIN"

export type OrderStakeholderTimelineEntry = {
  id: string
  kind:
    | "SECURITY_REVIEW_OPENED"
    | "SECURITY_REVIEW_CLEARED"
    | "SECURITY_VIOLATION_CONFIRMED"
    | "CUSTOMER_REFUND_COMPLETED"
    | "PUBLISHER_COMPENSATION_DECIDED"
  occurredAt: Date | string
  status: "PENDING" | "ACTION_REQUIRED" | "COMPLETED"
  severity: "INFO" | "WARNING" | "CRITICAL" | "SUCCESS"
  title: string
  summary: string
  financialImpact?: {
    currency: string
    customerRefund?: string
    publisherCompensation?: string
    debtApplied?: string
    netPublisherCredit?: string
  }
}

const ENFORCED_ORDER_STATUSES = new Set(["CANCELLED", "REFUNDED"])

function decimalString(value: unknown): string {
  if (value && typeof value === "object" && "toString" in value) {
    return String(value)
  }
  return String(value ?? "0")
}

function decimalDifference(left: unknown, right: unknown): string {
  // Values originate from canonical Decimal database columns. This projector
  // deliberately avoids Number() so financial display never loses cents.
  const leftParts = decimalString(left).split(".")
  const rightParts = decimalString(right).replace(/^-/, "").split(".")
  const scale = Math.max(leftParts[1]?.length ?? 0, rightParts[1]?.length ?? 0)
  const units = (parts: string[]) =>
    BigInt(`${parts[0] || "0"}${(parts[1] ?? "").padEnd(scale, "0")}`)
  const result = units(leftParts) - units(rightParts)
  const negative = result < 0n
  const absolute = (negative ? -result : result)
    .toString()
    .padStart(scale + 1, "0")
  if (scale === 0) return `${negative ? "-" : ""}${absolute}`
  const whole = absolute.slice(0, -scale)
  const fraction = absolute.slice(-scale).replace(/0+$/, "")
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`
}

function isPositiveDecimal(value: unknown): boolean {
  const normalized = decimalString(value).trim()
  return !normalized.startsWith("-") && /[1-9]/.test(normalized)
}

function evidenceDisposition(resolution: any): string | null {
  const evidence = resolution?.evidence
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) {
    return null
  }
  return typeof evidence.disposition === "string" ? evidence.disposition : null
}

function confirmedSummary(
  viewer: OrderStakeholderTimelineViewer,
  finding: any,
  orderTerminal: boolean,
): string {
  if (viewer === "SUPER_ADMIN" || viewer === "FINANCE") {
    return orderTerminal
      ? `The delivery-policy finding is confirmed. This order is terminal; any cancellation, refund, or compensation shown below is a separate authoritative record. Internal decision: ${finding.internalReason}`
      : `The delivery-policy finding is confirmed and requires financial resolution. Internal decision: ${finding.internalReason}`
  }
  if (viewer === "OPERATIONS") {
    return orderTerminal
      ? "The delivery-policy finding is confirmed. The terminal order outcome is recorded separately and is not automatically attributed to this finding."
      : "The delivery-policy finding is confirmed and has been escalated for financial resolution."
  }
  if (viewer === "PUBLISHER") {
    return orderTerminal
      ? "The delivery did not meet platform policy. Any order or financial outcome is recorded separately below."
      : "The delivery did not meet platform policy. The order is blocked while the financial outcome is reviewed."
  }
  return orderTerminal
    ? "The delivery did not meet platform policy. Any order or financial outcome is recorded separately below."
    : "The delivery did not meet platform policy. The order is blocked while the financial outcome is reviewed."
}

/**
 * Builds the persistent order-page decision history from immutable domain
 * evidence. It never trusts free-form OrderEvent metadata for financial truth
 * and never exposes investigator details to customers, publishers, or Ops.
 */
export function buildOrderStakeholderTimeline(
  order: any,
  viewer: OrderStakeholderTimelineViewer,
): OrderStakeholderTimelineEntry[] {
  const entries: OrderStakeholderTimelineEntry[] = []
  const orderTerminal = ENFORCED_ORDER_STATUSES.has(order.status)
  // Settlement authorization uses the database-maintained hold projection.
  // Stakeholder copy must read the same authority instead of inferring it
  // from historical flags or resolutions, which may be reconciled later.
  const reviewStillBlocked = (order.fraudFlags ?? []).some(
    (flag: any) => flag.hold != null,
  )

  for (const flag of order.fraudFlags ?? []) {
    entries.push({
      id: `fraud:${flag.id}:opened`,
      kind: "SECURITY_REVIEW_OPENED",
      occurredAt: flag.createdAt,
      status: flag.finding || flag.resolution ? "COMPLETED" : "PENDING",
      severity: "WARNING",
      title: "Delivery security review opened",
      summary:
        viewer === "OPERATIONS" ||
        viewer === "FINANCE" ||
        viewer === "SUPER_ADMIN"
          ? "A delivery signal requires staff review. Delivery acceptance and settlement remain blocked."
          : "This delivery is under security review. Acceptance and payment release are paused until the review is complete.",
    })

    if (flag.finding) {
      entries.push({
        id: `fraud-finding:${flag.finding.id}`,
        kind: "SECURITY_VIOLATION_CONFIRMED",
        occurredAt: flag.finding.createdAt,
        status: orderTerminal ? "COMPLETED" : "ACTION_REQUIRED",
        severity: "CRITICAL",
        title: "Delivery policy violation confirmed",
        summary: confirmedSummary(viewer, flag.finding, orderTerminal),
      })
      continue
    }

    if (flag.resolution) {
      const disposition = evidenceDisposition(flag.resolution)
      const acceptedRisk =
        disposition === "AUTHORIZED_REUSE" || disposition === "RISK_ACCEPTED"
      entries.push({
        id: `fraud-resolution:${flag.resolution.id}`,
        kind: "SECURITY_REVIEW_CLEARED",
        occurredAt: flag.resolution.createdAt,
        status: "COMPLETED",
        severity: "SUCCESS",
        title: acceptedRisk
          ? "Delivery security review authorized"
          : "Delivery security review cleared",
        summary:
          viewer === "SUPER_ADMIN" || viewer === "FINANCE"
            ? reviewStillBlocked
              ? `This signal was cleared, but another security hold still blocks the order. Internal decision: ${flag.resolution.reason}`
              : `This signal was cleared and no security holds remain. Internal decision: ${flag.resolution.reason}`
            : acceptedRisk
              ? reviewStillBlocked
                ? "This signal was authorized, but another security review still blocks the order."
                : "An authorized review completed and no security holds remain. Normal order checks still apply."
              : reviewStillBlocked
                ? "This signal was cleared, but another security review still blocks the order."
                : "The review completed without a confirmed policy violation. No security holds remain; normal order checks still apply.",
      })
    }
  }

  for (const refund of (order.transactions ?? []).filter(
    (transaction: any) => transaction.type === "REFUND",
  )) {
    const showAmount =
      viewer === "CUSTOMER" || viewer === "FINANCE" || viewer === "SUPER_ADMIN"
    entries.push({
      id: `refund:${refund.id}`,
      kind: "CUSTOMER_REFUND_COMPLETED",
      occurredAt: refund.createdAt,
      status: "COMPLETED",
      severity: "SUCCESS",
      title: "Customer refund completed",
      summary:
        viewer === "CUSTOMER"
          ? "The refund was returned to your platform wallet."
          : viewer === "PUBLISHER"
            ? "The customer refund is complete. Your publisher financial outcome is shown separately when applicable."
            : "The authoritative customer refund ledger entry is complete.",
      ...(showAmount && {
        financialImpact: {
          currency: refund.currency,
          customerRefund: decimalString(refund.amount),
        },
      }),
    })
  }

  const compensation = order.publisherCompensation
  if (compensation && viewer !== "CUSTOMER") {
    const debtApplied = compensation.debtRepaymentTransaction
      ? decimalString(compensation.debtRepaymentTransaction.amount).replace(
          /^-/,
          "",
        )
      : "0"
    const amount = decimalString(compensation.amount)
    const showAmount =
      viewer === "PUBLISHER" || viewer === "FINANCE" || viewer === "SUPER_ADMIN"
    entries.push({
      id: `publisher-compensation:${compensation.id}`,
      kind: "PUBLISHER_COMPENSATION_DECIDED",
      occurredAt: compensation.createdAt,
      status: "COMPLETED",
      severity: isPositiveDecimal(amount) ? "SUCCESS" : "INFO",
      title: "Publisher financial outcome recorded",
      summary:
        viewer === "PUBLISHER"
          ? compensation.disposition === "NONE"
            ? "The reviewed refund does not include publisher compensation."
            : "Publisher compensation was recorded. Any existing debt was netted before funds became withdrawable."
          : viewer === "OPERATIONS"
            ? "Finance recorded the publisher outcome for this refunded order."
            : `The authoritative publisher compensation decision is ${compensation.disposition}.`,
      ...(showAmount && {
        financialImpact: {
          currency: compensation.currency,
          publisherCompensation: amount,
          debtApplied,
          netPublisherCredit: decimalDifference(amount, debtApplied),
        },
      }),
    })
  }

  return entries.sort((left, right) => {
    const time =
      new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime()
    return time || left.id.localeCompare(right.id)
  })
}
