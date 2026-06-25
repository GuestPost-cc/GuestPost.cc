// Business-context tagging for Sentry events.
//
// Called from:
//   - API: NestJS interceptor pulls req.user + route params
//   - Worker: attachObservability() pulls from job data (e.g. orderId, ticketId)
//   - Frontend: Providers component subscribes to AuthProvider, calls on identity change
//
// All fields optional — only set what's available. Idempotent: calling twice
// with the same scope overwrites prior tags. Never throws on unknown keys.

export interface BusinessContext {
  // Who
  userType?: "CUSTOMER" | "PUBLISHER" | "STAFF" | string
  staffRole?: string
  customerRole?: string
  publisherRole?: string
  organizationId?: string
  publisherId?: string
  // What entity the action touches
  orderId?: string
  ticketId?: string
  settlementId?: string
  // Channel / service classification
  fulfillmentChannel?: "PLATFORM" | "PUBLISHER" | string
  serviceType?: string
}

// Sentry scope shape (loose) — both @sentry/node and @sentry/nextjs scopes
// expose setTag(key, value). We don't need anything else.
export interface SentryScopeLike {
  setTag: (
    key: string,
    value: string | number | boolean | null | undefined,
  ) => unknown
}

// Apply a business context to a Sentry scope. Pass only defined keys so we
// never clobber a useful tag with `undefined`.
export function setBusinessContext(
  scope: SentryScopeLike,
  ctx: BusinessContext,
): void {
  for (const [key, value] of Object.entries(ctx) as Array<
    [keyof BusinessContext, unknown]
  >) {
    if (value === undefined || value === null) continue
    if (
      typeof value !== "string" &&
      typeof value !== "number" &&
      typeof value !== "boolean"
    )
      continue
    scope.setTag(key, value)
  }
}
