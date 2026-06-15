// Phase 7.0 — Next 15 instrumentation hook (Sentry server + edge init).
// Called once at app boot per runtime.
import { initSentry } from "@guestpost/shared"

export async function register(): Promise<void> {
  const Sentry = await import("@sentry/nextjs")
  if (process.env.NEXT_RUNTIME === "nodejs") {
    initSentry(Sentry, { runtime: "portal-server" })
  } else if (process.env.NEXT_RUNTIME === "edge") {
    initSentry(Sentry, { runtime: "portal-edge" })
  }
}

// Forward request-level errors to Sentry (per Next 15 instrumentation contract).
export { captureRequestError as onRequestError } from "@sentry/nextjs"
