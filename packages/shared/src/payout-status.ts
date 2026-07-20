// Provider status lookups shared by the API adapters and the worker's
// status poller. Pure fetch — no framework dependencies.
//
// Returns null when the provider API key is not configured: callers must
// SKIP the execution, never assume completion. (A missing key must not be
// able to mark money as moved.)

export type ProviderTransferStatus = "PROCESSING" | "COMPLETED" | "FAILED"

export interface ProviderStatusResult {
  status: ProviderTransferStatus
  fee?: number
  metadata?: Record<string, unknown>
}

export const WISE_STATUS_MAP: Record<string, ProviderTransferStatus> = {
  processing: "PROCESSING",
  funds_converted: "PROCESSING",
  outgoing_payment_sent: "PROCESSING",
  completed: "COMPLETED",
  cancelled: "FAILED",
  failed: "FAILED",
}

export const STRIPE_STATUS_MAP: Record<string, ProviderTransferStatus> = {
  pending: "PROCESSING",
  in_transit: "PROCESSING",
  paid: "COMPLETED",
  canceled: "FAILED",
  failed: "FAILED",
}

export async function checkWiseTransferStatus(
  providerExecutionId: string,
): Promise<ProviderStatusResult | null> {
  const apiKey = process.env.WISE_API_KEY
  if (!apiKey) return null

  const response = await fetch(
    `https://api.transferwise.com/v1/transfers/${providerExecutionId}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  )
  if (!response.ok) {
    throw new Error(`Wise status check failed: ${response.status}`)
  }
  const data = (await response.json()) as any
  return {
    status: WISE_STATUS_MAP[data.status as string] ?? "PROCESSING",
    fee: Number(data.fee?.amount ?? 0),
    metadata: {
      wiseStatus: data.status,
      estimatedDelivery: data.estimatedDelivery,
    },
  }
}

export async function checkStripeTransferStatus(
  providerExecutionId: string,
  connectedAccountId?: string,
): Promise<ProviderStatusResult | null> {
  const apiKey = process.env.STRIPE_SECRET_KEY
  if (!apiKey) return null
  const keyMode = apiKey.startsWith("sk_test_")
    ? "test"
    : apiKey.startsWith("sk_live_")
      ? "live"
      : "invalid"
  if (keyMode === "invalid") {
    throw new Error("Stripe status check requires an sk_test_ or sk_live_ key")
  }
  if (
    keyMode === "live" &&
    process.env.STRIPE_LIVE_MODE_ENABLED?.toLowerCase() !== "true"
  ) {
    throw new Error(
      "Live Stripe status check refused while live mode is disabled",
    )
  }

  // A Stripe Transfer has no bank-settlement status. Only a Payout created on
  // the connected account can complete the publisher withdrawal.
  if (providerExecutionId.startsWith("tr_")) {
    return {
      status: "PROCESSING",
      metadata: { stage: "TRANSFER_CREATED" },
    }
  }
  if (!providerExecutionId.startsWith("po_") || !connectedAccountId) {
    throw new Error("Stripe payout status requires a connected account")
  }

  const response = await fetch(
    `https://api.stripe.com/v1/payouts/${providerExecutionId}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Stripe-Account": connectedAccountId,
      },
    },
  )
  if (!response.ok) {
    throw new Error(`Stripe status check failed: ${response.status}`)
  }
  const data = (await response.json()) as any
  if (
    typeof data.livemode !== "boolean" ||
    data.livemode !== (keyMode === "live")
  ) {
    throw new Error("Stripe payout mode does not match the configured key")
  }
  return {
    status: STRIPE_STATUS_MAP[data.status as string] ?? "PROCESSING",
    metadata: {
      stripeStatus: data.status,
      arrivalDate: data.arrival_date,
      connectedAccountId,
      stage: data.status === "paid" ? "BANK_PAID" : "BANK_PAYOUT_CREATED",
    },
  }
}

export async function checkProviderTransferStatus(
  providerName: string,
  providerExecutionId: string,
  context?: { connectedAccountId?: string },
): Promise<ProviderStatusResult | null> {
  switch (providerName) {
    case "wise":
      return checkWiseTransferStatus(providerExecutionId)
    case "stripe_connect":
      return checkStripeTransferStatus(
        providerExecutionId,
        context?.connectedAccountId,
      )
    default:
      // manual + unknown providers have no remote status to poll
      return null
  }
}
