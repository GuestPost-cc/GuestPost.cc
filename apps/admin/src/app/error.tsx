"use client"

// Phase 7.0 — segment-level error boundary.
// Fires when a route segment / page throws during render. Reports to Sentry
// (no-op without DSN), renders branded fallback, offers a Reset button that
// re-mounts the segment.

import { ErrorState } from "@guestpost/ui"
import * as Sentry from "@sentry/nextjs"
import { useEffect } from "react"

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { source: "next-error-boundary" },
      extra: { digest: error.digest },
    })
  }, [error])

  return (
    <ErrorState
      title="Something went wrong"
      description={
        error.digest
          ? `An unexpected error occurred. Reference: ${error.digest}`
          : "An unexpected error occurred. Please try again."
      }
      onRetry={reset}
    />
  )
}
