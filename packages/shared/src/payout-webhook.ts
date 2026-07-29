// Normalizes raw provider webhook payloads into the shape the payout worker
// acts on. The worker previously expected `data.status === "COMPLETED"` and
// `data.id` — neither matches what Wise or Stripe actually send, so every
// genuine provider webhook was skipped and the 10-minute status poller was
// the only completion mechanism.
//
// Status mapping reuses the SAME maps as the status poller (payout-status.ts)
// so the two paths can never disagree about what a provider state means.

import {
  type ProviderTransferStatus,
  STRIPE_STATUS_MAP,
  WISE_STATUS_MAP,
} from "./payout-status"

export interface NormalizedPayoutWebhook {
  // Provider's transfer/payout id — matches PayoutExecution.providerExecutionId
  providerExecutionId: string | null
  // Normalized status; null = event carries no actionable state change
  status: ProviderTransferStatus | null
  // Provider's raw state string, for audit metadata
  rawStatus: string | null
  // Provider-reported integer minor units and ISO currency. These are trusted
  // only after signature verification and are required for Stripe payout
  // completion; never derive them from browser or queue metadata.
  payoutAmountMinor: bigint | null
  payoutCurrency: string | null
  error: string | null
}

function normalizedMinorAmount(value: unknown): bigint | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) {
    return BigInt(value)
  }
  if (typeof value === "bigint" && value > 0n) return value
  if (typeof value === "string" && /^[1-9]\d*$/.test(value)) {
    return BigInt(value)
  }
  return null
}

function normalizedCurrency(value: unknown): string | null {
  if (typeof value !== "string") return null
  const currency = value.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(currency) ? currency : null
}

// Wise (transfers#state-change):
//   { data: { resource: { id, ... }, current_state, previous_state, ... },
//     event_type: "transfers#state-change", ... }
// The API webhook controller enqueues `body.data ?? body`, so the worker may
// see either the full envelope or the inner data object — accept both.
function normalizeWise(body: any): NormalizedPayoutWebhook {
  const inner = body?.data ?? body ?? {}
  const resourceId = inner?.resource?.id ?? inner?.id ?? null
  const rawStatus: string | null = inner?.current_state ?? inner?.status ?? null
  return {
    providerExecutionId: resourceId != null ? String(resourceId) : null,
    status: rawStatus ? (WISE_STATUS_MAP[rawStatus] ?? null) : null,
    rawStatus,
    payoutAmountMinor: null,
    payoutCurrency: null,
    error: null,
  }
}

// Stripe event envelope:
//   { id: "evt_...", type: "transfer.updated" | "payout.paid" | "payout.failed",
//     data: { object: { id: "tr_.../po_...", status, failure_message?, ... } } }
// Same envelope-or-inner tolerance as Wise.
function normalizeStripe(body: any): NormalizedPayoutWebhook {
  const object = body?.data?.object ?? body?.object ?? body ?? {}
  const eventType: string | null =
    typeof body?.type === "string" ? body.type : null
  const rawStatus: string | null = object?.status ?? null
  const mappedStatus = rawStatus ? (STRIPE_STATUS_MAP[rawStatus] ?? null) : null
  let status: ProviderTransferStatus | null = null
  if (eventType === "payout.paid" && rawStatus === "paid") {
    status = "COMPLETED"
  } else if (
    (eventType === "payout.failed" && rawStatus === "failed") ||
    (eventType === "payout.canceled" && rawStatus === "canceled")
  ) {
    status = "FAILED"
  } else if (
    eventType === "payout.created" ||
    eventType === "payout.updated" ||
    eventType === "transfer.created" ||
    eventType === "transfer.updated" ||
    eventType === "transfer.reversed"
  ) {
    // Object status is a current snapshot, not proof that this particular
    // event announced a terminal transition. Only Stripe's typed terminal
    // events above may authorize completion/failure.
    status = "PROCESSING"
  } else if (eventType === null) {
    // Retain the legacy inner-object normalization for trusted internal callers.
    // Public Stripe webhooks always pass the full verified Event envelope.
    status = mappedStatus
  }
  return {
    providerExecutionId: object?.id != null ? String(object.id) : null,
    status,
    rawStatus,
    payoutAmountMinor: normalizedMinorAmount(object?.amount),
    payoutCurrency: normalizedCurrency(object?.currency),
    error: object?.failure_message ?? object?.failure_code ?? null,
  }
}

// Internal/replay shape (manual re-drives, tests): already normalized.
function normalizeInternal(data: any): NormalizedPayoutWebhook | null {
  const id = data?.providerExecutionId
  const status = data?.status
  if (
    id == null ||
    (status !== "COMPLETED" && status !== "FAILED" && status !== "PROCESSING")
  )
    return null
  return {
    providerExecutionId: String(id),
    status,
    rawStatus: status,
    payoutAmountMinor: normalizedMinorAmount(
      data?.payoutAmountMinor ?? data?.amountMinor,
    ),
    payoutCurrency: normalizedCurrency(data?.payoutCurrency ?? data?.currency),
    error: data?.error ?? null,
  }
}

export function normalizeProviderWebhook(
  provider: string,
  data: any,
): NormalizedPayoutWebhook {
  // Pre-normalized payloads pass through untouched regardless of provider
  const internal = normalizeInternal(data)
  if (internal) return internal

  switch (provider) {
    case "wise":
      return normalizeWise(data)
    case "stripe_connect":
      return normalizeStripe(data)
    default:
      return {
        providerExecutionId: null,
        status: null,
        rawStatus: null,
        payoutAmountMinor: null,
        payoutCurrency: null,
        error: null,
      }
  }
}
