// Provider status lookups shared by the API adapters and the worker's
// status poller. Pure fetch — no framework dependencies.
//
// Returns null when the provider API key is not configured: callers must
// SKIP the execution, never assume completion. (A missing key must not be
// able to mark money as moved.)

import {
  classifyStripeKeyMode,
  StripeConfigurationError,
} from "./stripe-key-mode"

export type ProviderTransferStatus = "PROCESSING" | "COMPLETED" | "FAILED"

export function isPaidWithdrawalStatus(status: unknown): status is "COMPLETED" {
  return status === "COMPLETED"
}

export interface ProviderStatusResult {
  status: ProviderTransferStatus
  providerAmountMinor?: number
  providerCurrency?: string
  livemode?: boolean
  fee?: number
  metadata?: Record<string, unknown>
}

export const WISE_STATUS_MAP: Record<string, ProviderTransferStatus> = {
  incoming_payment_waiting: "PROCESSING",
  incoming_payment_initiated: "PROCESSING",
  processing: "PROCESSING",
  funds_converted: "PROCESSING",
  outgoing_payment_sent: "PROCESSING",
  cancelled: "FAILED",
  funds_refunded: "FAILED",
  bounced_back: "FAILED",
  charged_back: "FAILED",
  unknown: "PROCESSING",
}

export const STRIPE_STATUS_MAP: Record<string, ProviderTransferStatus> = {
  pending: "PROCESSING",
  in_transit: "PROCESSING",
  paid: "COMPLETED",
  canceled: "FAILED",
  failed: "FAILED",
}

const PROVIDER_STATUS_TIMEOUT_MS = 10_000
const PROVIDER_STATUS_MAX_RESPONSE_BYTES = 64 * 1024

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

async function readBoundedProviderJson(
  response: Response,
  provider: "Stripe" | "Wise",
): Promise<Record<string, unknown>> {
  const contentLength = Number(response.headers?.get("content-length"))
  if (
    Number.isFinite(contentLength) &&
    contentLength > PROVIDER_STATUS_MAX_RESPONSE_BYTES
  ) {
    throw new Error(`${provider} status response exceeds the safe size limit`)
  }
  const contentType = response.headers?.get("content-type")
  if (contentType && !contentType.toLowerCase().includes("application/json")) {
    throw new Error(`${provider} status response is not JSON`)
  }

  let parsed: unknown
  if (response.body?.getReader) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    while (true) {
      const next = await reader.read()
      if (next.done) break
      total += next.value.byteLength
      if (total > PROVIDER_STATUS_MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error(
          `${provider} status response exceeds the safe size limit`,
        )
      }
      chunks.push(next.value)
    }
    const body = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      body.set(chunk, offset)
      offset += chunk.byteLength
    }
    try {
      parsed = JSON.parse(new TextDecoder().decode(body))
    } catch {
      throw new Error(`${provider} status response is not valid JSON`)
    }
  } else if (typeof response.text === "function") {
    const body = await response.text()
    if (
      new TextEncoder().encode(body).byteLength >
      PROVIDER_STATUS_MAX_RESPONSE_BYTES
    ) {
      throw new Error(`${provider} status response exceeds the safe size limit`)
    }
    try {
      parsed = JSON.parse(body)
    } catch {
      throw new Error(`${provider} status response is not valid JSON`)
    }
  } else {
    // Lightweight unit-test response doubles do not always implement a stream.
    parsed = await response.json()
    if (
      new TextEncoder().encode(JSON.stringify(parsed)).byteLength >
      PROVIDER_STATUS_MAX_RESPONSE_BYTES
    ) {
      throw new Error(`${provider} status response exceeds the safe size limit`)
    }
  }
  if (!isRecord(parsed)) {
    throw new Error(`${provider} status response has an invalid schema`)
  }
  return parsed
}

async function fetchProviderStatus(
  provider: "Stripe" | "Wise",
  url: string,
  init: RequestInit,
): Promise<Response> {
  try {
    return await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(PROVIDER_STATUS_TIMEOUT_MS),
    })
  } catch (error) {
    const name = error instanceof Error ? error.name : ""
    if (name === "AbortError" || name === "TimeoutError") {
      throw new Error(`${provider} status check timed out`)
    }
    throw new Error(`${provider} status check request failed`)
  }
}

export async function checkWiseTransferStatus(
  providerExecutionId: string,
): Promise<ProviderStatusResult | null> {
  const apiKey = process.env.WISE_API_KEY
  if (!apiKey) return null

  const response = await fetchProviderStatus(
    "Wise",
    `https://api.transferwise.com/v1/transfers/${providerExecutionId}`,
    {
      headers: { Authorization: `Bearer ${apiKey}` },
    },
  )
  if (!response.ok) {
    throw new Error(`Wise status check failed: ${response.status}`)
  }
  const data = await readBoundedProviderJson(response, "Wise")
  if (
    typeof data.status !== "string" ||
    data.status.length === 0 ||
    (data.fee !== undefined &&
      (!isRecord(data.fee) ||
        !Number.isFinite(Number(data.fee.amount)) ||
        Number(data.fee.amount) < 0))
  ) {
    throw new Error("Wise status response has an invalid schema")
  }
  const fee = isRecord(data.fee) ? Number(data.fee.amount) : 0
  return {
    status: WISE_STATUS_MAP[data.status] ?? "PROCESSING",
    fee,
    metadata: {
      wiseStatus: data.status,
      estimatedDelivery:
        typeof data.estimatedDelivery === "string"
          ? data.estimatedDelivery
          : undefined,
    },
  }
}

export async function checkStripeTransferStatus(
  providerExecutionId: string,
  connectedAccountId?: string,
  expected?: {
    amountMinor?: number
    currency?: string
    publicReference?: string
  },
): Promise<ProviderStatusResult | null> {
  const apiKey = process.env.STRIPE_SECRET_KEY?.trim()
  const keyMode = classifyStripeKeyMode(apiKey)
  if (keyMode === "none") return null
  if (keyMode === "invalid") {
    throw new StripeConfigurationError(
      "STRIPE_KEY_INVALID",
      "Stripe status check requires a valid secret or restricted key",
    )
  }
  if (
    keyMode === "live" &&
    process.env.STRIPE_LIVE_MODE_ENABLED?.toLowerCase() !== "true"
  ) {
    throw new StripeConfigurationError(
      "STRIPE_LIVE_MODE_DISABLED",
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
  if (
    !providerExecutionId.startsWith("po_") ||
    !connectedAccountId ||
    !Number.isSafeInteger(expected?.amountMinor) ||
    Number(expected?.amountMinor) <= 0 ||
    !expected?.currency ||
    !expected.publicReference
  ) {
    throw new StripeConfigurationError(
      "STRIPE_PAYOUT_CONTEXT_INVALID",
      "Stripe payout status requires immutable account, amount, currency, and reference context",
    )
  }

  const response = await fetchProviderStatus(
    "Stripe",
    `https://api.stripe.com/v1/payouts/${providerExecutionId}`,
    {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Stripe-Account": connectedAccountId,
      },
    },
  )
  if (!response.ok) {
    throw new StripeConfigurationError(
      "STRIPE_PROVIDER_REQUEST_FAILED",
      `Stripe status check failed with HTTP ${response.status}`,
    )
  }
  let data: Record<string, unknown>
  try {
    data = await readBoundedProviderJson(response, "Stripe")
  } catch (error) {
    throw new StripeConfigurationError(
      "STRIPE_PROVIDER_EVIDENCE_MISMATCH",
      error instanceof Error
        ? error.message
        : "Stripe status response is invalid",
    )
  }
  const metadata = isRecord(data.metadata) ? data.metadata : null
  if (
    typeof data.livemode !== "boolean" ||
    data.livemode !== (keyMode === "live")
  ) {
    throw new StripeConfigurationError(
      "STRIPE_PROVIDER_MODE_MISMATCH",
      "Stripe payout mode does not match the configured key",
    )
  }
  if (
    data.id !== providerExecutionId ||
    !Number.isSafeInteger(data.amount) ||
    data.amount !== expected.amountMinor ||
    typeof data.status !== "string" ||
    data.status.length === 0 ||
    typeof data.currency !== "string" ||
    String(data.currency ?? "").toUpperCase() !==
      expected.currency.toUpperCase() ||
    metadata?.withdrawal_reference !== expected.publicReference
  ) {
    throw new StripeConfigurationError(
      "STRIPE_PROVIDER_EVIDENCE_MISMATCH",
      "Stripe payout status evidence does not match the immutable payout command",
    )
  }
  return {
    status: STRIPE_STATUS_MAP[data.status] ?? "PROCESSING",
    providerAmountMinor: data.amount as number,
    providerCurrency:
      typeof data.currency === "string"
        ? data.currency.toUpperCase()
        : undefined,
    livemode: data.livemode,
    metadata: {
      stripeStatus: data.status,
      arrivalDate: data.arrival_date,
      connectedAccountId,
      providerAmountMinor: data.amount,
      providerCurrency:
        typeof data.currency === "string"
          ? data.currency.toUpperCase()
          : undefined,
      providerPublicReference: metadata?.withdrawal_reference,
      livemode: data.livemode,
      stage: data.status === "paid" ? "BANK_PAID" : "BANK_PAYOUT_CREATED",
    },
  }
}

export async function checkProviderTransferStatus(
  providerName: string,
  providerExecutionId: string,
  context?: {
    connectedAccountId?: string
    expectedAmountMinor?: number
    expectedCurrency?: string
    expectedPublicReference?: string
  },
): Promise<ProviderStatusResult | null> {
  switch (providerName) {
    case "wise":
      // Wise is intentionally absent from the certified provider set. Keeping
      // this dispatcher fail-closed prevents a future caller from bypassing
      // the API adapter quarantine and turning an incomplete status model into
      // money-state authority.
      return null
    case "stripe_connect":
      return checkStripeTransferStatus(
        providerExecutionId,
        context?.connectedAccountId,
        {
          amountMinor: context?.expectedAmountMinor,
          currency: context?.expectedCurrency,
          publicReference: context?.expectedPublicReference,
        },
      )
    default:
      // manual + unknown providers have no remote status to poll
      return null
  }
}
