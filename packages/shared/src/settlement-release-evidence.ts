export type SettlementReleaseEvidenceCode =
  | "SETTLEMENT_NOT_RELEASED"
  | "SETTLEMENT_SETTLED_AT_MISSING"
  | "SETTLEMENT_RELEASE_LEDGER_COUNT"
  | "SETTLEMENT_RELEASE_LEDGER_IDENTITY"
  | "SETTLEMENT_RELEASE_EVENT_COUNT"
  | "SETTLEMENT_RELEASE_EVENT_IDENTITY"

export interface SettlementReleaseEvidenceIssue {
  code: SettlementReleaseEvidenceCode
  message: string
}

export interface SettlementReleaseEvidenceInput {
  settlement: {
    id: string
    orderId: string
    publisherId: string
    publisherAmount: unknown
    currency: string
    status: string
    settledAt: unknown | null
  }
  transactions?: Array<{
    type: string
    settlementId: string | null
    orderId: string | null
    publisherId: string | null
    amount: unknown
    currency: string
    walletId?: string | null
    provider?: string | null
    providerRef?: string | null
  }>
  events?: Array<{
    eventType: string
    settlementId?: string | null
    orderId: string
  }>
}

function decimalUnits(value: unknown): bigint | null {
  const text = String(value ?? "")
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null
  const negative = text.startsWith("-")
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".")
  const units =
    BigInt(whole) * 1_000_000_000_000n +
    BigInt(`${fraction}000000000000`.slice(0, 12))
  return negative ? -units : units
}

/**
 * Pure proof of the release triple for a publisher settlement:
 * RELEASED state, one exact append-only ledger row, and one exact release
 * event. Callers must load the complete release-row/event sets, not a sample.
 */
export function evaluateSettlementReleaseEvidence(
  input: SettlementReleaseEvidenceInput,
): {
  valid: boolean
  stateValid: boolean
  ledgerValid: boolean
  eventValid: boolean
  issues: SettlementReleaseEvidenceIssue[]
} {
  const { settlement } = input
  const issues: SettlementReleaseEvidenceIssue[] = []

  if (settlement.status !== "RELEASED") {
    issues.push({
      code: "SETTLEMENT_NOT_RELEASED",
      message: `Settlement status is ${settlement.status}, expected RELEASED`,
    })
  }
  if (!settlement.settledAt) {
    issues.push({
      code: "SETTLEMENT_SETTLED_AT_MISSING",
      message: "Released settlement is missing its release timestamp",
    })
  }

  const releaseTransactions = (input.transactions ?? []).filter(
    (transaction) => transaction.type === "SETTLEMENT_RELEASE",
  )
  if (releaseTransactions.length !== 1) {
    issues.push({
      code: "SETTLEMENT_RELEASE_LEDGER_COUNT",
      message: `Expected one settlement release ledger row, found ${releaseTransactions.length}`,
    })
  } else {
    const transaction = releaseTransactions[0]
    const exactAmount =
      decimalUnits(transaction.amount) !== null &&
      decimalUnits(transaction.amount) ===
        decimalUnits(settlement.publisherAmount)
    if (
      transaction.settlementId !== settlement.id ||
      transaction.orderId !== settlement.orderId ||
      transaction.publisherId !== settlement.publisherId ||
      transaction.currency !== settlement.currency ||
      !exactAmount ||
      transaction.walletId != null ||
      transaction.provider != null ||
      transaction.providerRef != null
    ) {
      issues.push({
        code: "SETTLEMENT_RELEASE_LEDGER_IDENTITY",
        message:
          "Settlement release ledger row does not match the settlement identity and amount",
      })
    }
  }

  const releaseEvents = (input.events ?? []).filter(
    (event) => event.eventType === "SETTLEMENT_RELEASED",
  )
  if (releaseEvents.length !== 1) {
    issues.push({
      code: "SETTLEMENT_RELEASE_EVENT_COUNT",
      message: `Expected one settlement release event, found ${releaseEvents.length}`,
    })
  } else {
    const event = releaseEvents[0]
    if (
      event.settlementId !== settlement.id ||
      event.orderId !== settlement.orderId
    ) {
      issues.push({
        code: "SETTLEMENT_RELEASE_EVENT_IDENTITY",
        message:
          "Settlement release event does not match the settlement and order",
      })
    }
  }

  const stateValid = !issues.some(
    (issue) =>
      issue.code === "SETTLEMENT_NOT_RELEASED" ||
      issue.code === "SETTLEMENT_SETTLED_AT_MISSING",
  )
  const ledgerValid = !issues.some((issue) =>
    issue.code.startsWith("SETTLEMENT_RELEASE_LEDGER_"),
  )
  const eventValid = !issues.some((issue) =>
    issue.code.startsWith("SETTLEMENT_RELEASE_EVENT_"),
  )
  return {
    valid: stateValid && ledgerValid && eventValid,
    stateValid,
    ledgerValid,
    eventValid,
    issues,
  }
}
