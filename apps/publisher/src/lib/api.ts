import {
  buildAuthErrorHandler,
  createApiClient,
  resolveApiV1Url,
} from "@guestpost/api-client"

export const getApiUrl = () =>
  resolveApiV1Url({
    configuredUrl: process.env.NEXT_PUBLIC_API_URL,
    nodeEnv: process.env.NODE_ENV,
  })

// Phase 6.8 — Audit finding #7 closure. See apps/portal/src/lib/api.ts for
// the full rationale + packages/api-client/src/auth-redirect.ts for the
// security contract (idempotency, URL sanitization, auth-endpoint skip).
export const api = createApiClient({
  baseUrl: getApiUrl(),
  onAuthError: buildAuthErrorHandler({ signInPath: "/" }),
})
