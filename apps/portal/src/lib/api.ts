import {
  buildAuthErrorHandler,
  clearToken,
  createApiClient,
  getToken,
  setToken,
} from "@guestpost/api-client"

export const getApiUrl = () => {
  const envUrl = process.env.NEXT_PUBLIC_API_URL
  if (envUrl) return `${envUrl}/api/v1`
  if (typeof window !== "undefined") {
    const host = window.location.hostname
    if (host !== "localhost" && host !== "127.0.0.1") {
      return `http://${host}:4000/api/v1`
    }
  }
  return "http://localhost:4000/api/v1"
}

// Phase 6.8 — Audit finding #7 closure.
// 401 from a non-auth endpoint means the session is gone (expired / revoked /
// invalidated). Clear the token and bounce the user to the sign-in page with
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
export { clearToken, getToken, setToken }
