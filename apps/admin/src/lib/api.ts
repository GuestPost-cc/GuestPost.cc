import { createApiClient, setToken, clearToken, getToken, buildAuthErrorHandler, isAuthEndpointPath } from "@guestpost/api-client"

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
const onAuthError = buildAuthErrorHandler({ signInPath: "/" })

export const api = createApiClient({
  baseUrl: getApiUrl(),
  onAuthError,
})
export { setToken, clearToken, getToken }

// The two helpers below predate Phase 6.8 and bypass the typed HttpClient,
// so they need their own 401 handling. Mirror the same contract: skip the
// redirect for auth endpoints (which never reach these in practice but
// defense in depth), trigger it for everything else.
function handle401(path: string) {
  if (!isAuthEndpointPath(path)) onAuthError()
}

/** Fetch helper that throws on non-ok responses. Calls getApiUrl() at fetch time. */
export async function adminFetch(path: string) {
  const token = getToken()
  const res = await fetch(`${getApiUrl()}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    credentials: "include",
  })
  if (res.status === 401) handle401(path)
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

/** Fetch helper that returns the raw Response (caller checks res.ok). */
export async function authFetch(url: string) {
  const token = getToken()
  const res = await fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    credentials: "include",
  })
  if (res.status === 401) handle401(url)
  return res
}
