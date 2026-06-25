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
  error: string | null
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
    error: null,
  }
}

// Stripe event envelope:
//   { id: "evt_...", type: "transfer.updated" | "payout.paid" | "payout.failed",
//     data: { object: { id: "tr_.../po_...", status, failure_message?, ... } } }
// Same envelope-or-inner tolerance as Wise.
function normalizeStripe(body: any): NormalizedPayoutWebhook {
  const object = body?.data?.object ?? body?.object ?? body ?? {}
  const rawStatus: string | null = object?.status ?? null
  return {
    providerExecutionId: object?.id != null ? String(object.id) : null,
    status: rawStatus ? (STRIPE_STATUS_MAP[rawStatus] ?? null) : null,
    rawStatus,
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
        error: null,
      }
  }
}
