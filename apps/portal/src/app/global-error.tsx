"use client"

// Phase 7.0 — root-level catastrophic error boundary.
// Fires when the root layout itself throws (e.g. provider crash). Must declare
// its own <html>/<body>; cannot rely on @guestpost/ui or any layout being loaded.
// Styles inlined defensively.

import { useEffect } from "react"
import * as Sentry from "@sentry/nextjs"

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string }
  reset: () => void
}) {
  useEffect(() => {
    Sentry.captureException(error, {
      tags: { source: "next-global-error-boundary" },
      extra: { digest: error.digest },
    })
  }, [error])

  return (
    <html lang="en">
      <body
        style={{
          fontFamily: "system-ui, -apple-system, sans-serif",
          padding: "3rem 1.5rem",
          textAlign: "center",
          color: "#111",
          backgroundColor: "#fff",
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          margin: 0,
        }}
      >
        <h1 style={{ fontSize: "1.5rem", fontWeight: 600, marginBottom: "0.75rem" }}>
          Something went wrong
        </h1>
        <p style={{ marginBottom: "1.5rem", color: "#555", maxWidth: "32rem" }}>
          {error.digest
            ? `An unexpected error occurred. Reference: ${error.digest}`
            : "An unexpected error occurred. Please try again."}
        </p>
        <button
          onClick={reset}
          style={{
            padding: "0.5rem 1.25rem",
            border: "1px solid #d4d4d8",
            borderRadius: "0.375rem",
            backgroundColor: "#fff",
            cursor: "pointer",
            fontSize: "0.875rem",
            fontWeight: 500,
          }}
        >
          Try again
        </button>
      </body>
    </html>
  )
}
