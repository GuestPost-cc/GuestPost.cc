// Phase 7.0 — Next 15 instrumentation hook (Sentry server + edge init).
import { initSentry } from "@guestpost/shared"

export async function register(): Promise<void> {
  const Sentry = await import("@sentry/nextjs")
  if (process.env.NEXT_RUNTIME === "nodejs") {
    initSentry(Sentry, { runtime: "website-server" })
  } else if (process.env.NEXT_RUNTIME === "edge") {
    initSentry(Sentry, { runtime: "website-edge" })
  }
}

export { captureRequestError as onRequestError } from "@sentry/nextjs"
