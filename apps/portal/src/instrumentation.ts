// Phase 7.0 — Next 15 instrumentation hook (Sentry server init).
import { initSentry } from "@guestpost/shared"

export async function register(): Promise<void> {
  const Sentry = await import("@sentry/nextjs")
  if (process.env.NEXT_RUNTIME === "nodejs") {
    initSentry(Sentry, { runtime: "portal-server" })
  }
  // Edge runtime init skipped - Turbopack hangs on edge compilation in instrumentation
}

// Forward request-level errors to Sentry (per Next 15 instrumentation contract).
export { captureRequestError as onRequestError } from "@sentry/nextjs"
