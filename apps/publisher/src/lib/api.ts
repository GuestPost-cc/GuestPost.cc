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

// Phase 6.8 — Audit finding #7 closure. See apps/portal/src/lib/api.ts for
// the full rationale + packages/api-client/src/auth-redirect.ts for the
// security contract (idempotency, URL sanitization, auth-endpoint skip).
export const api = createApiClient({
  baseUrl: getApiUrl(),
  onAuthError: buildAuthErrorHandler({ signInPath: "/" }),
})
export { clearToken, getToken, setToken }
