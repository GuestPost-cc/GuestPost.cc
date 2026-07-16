export * from "./audit/order-event-metadata"
export * from "./briefs"
export * from "./constants"
export * from "./dns-verification"
export * from "./lifecycle/listing-phase"
export * from "./notification-dedup-keys"
export * from "./observability"
export * from "./order-cancellation-config"
export * from "./order-cancellation-policy"
export * from "./order-priority"
// NOT re-exported: job-signing uses Node crypto (HMAC) — server-only.
// Consumer deep-import via `@guestpost/shared/dist/job-signing`.
export * from "./payout-status"
export * from "./payout-webhook"
export * from "./platform-fee-core"
export * from "./publisher-tier-policy"
// NOT re-exported: publisher-trust-core struggles structured-logger → request-context
// (node:async_hooks). Browser consumers that barrel-import @guestpost/shared would
// crash. Consumers deep-import via @guestpost/shared/dist/publisher-trust-core.
export * from "./queues"
export * from "./reconciliation-core"
export * from "./schemas"
export * from "./settlement-auto-approve-core"
export * from "./settlement-auto-release-core"
export * from "./settlement-gating"
export * from "./trust-score"
export * from "./types"
export * from "./url-normalize"
export * from "./webhook-timestamp"
export * from "./website-verification-core"
export * from "./workflow/decision-service"
export * from "./workflow/workflow-config"

// IMPORTANT: do NOT re-export Node-only modules here.
// - safe-fetch (Phase 7.11) imports node:dns + undici → can't be bundled by
//   the Next.js apps' webpack (UnhandledSchemeError on `node:*`).
// - Same constraint as delivery-verification-core, object-storage,
//   observability/structured-logger — all consumed via deep imports
//   like `@guestpost/shared/dist/safe-fetch` from the worker only.
