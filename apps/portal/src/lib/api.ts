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

// Phase 6.8 — Audit finding #7 closure.
// 401 from a non-auth endpoint means the session is gone (expired / revoked /
// invalidated). Bounce the user to the sign-in page with
// a sanitized `returnTo` so they land back where they were after re-auth.
// See packages/api-client/src/auth-redirect.ts for the security contract.
//
// The cache-clear callback runs at the page boundary (the new page mounts a
// fresh QueryClient anyway), so we don't need to thread the QueryClient
// instance into this module-level export.
export const api = createApiClient({
  baseUrl: getApiUrl(),
  onAuthError: buildAuthErrorHandler({ signInPath: "/" }),
})
