import { createApiClient, setToken, clearToken, getToken } from "@guestpost/api-client"

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

export const api = createApiClient({ baseUrl: getApiUrl() })
export { setToken, clearToken, getToken }

/** Fetch helper that throws on non-ok responses. Calls getApiUrl() at fetch time. */
export async function adminFetch(path: string) {
  const token = getToken()
  const res = await fetch(`${getApiUrl()}/api/v1${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    credentials: "include",
  })
  if (!res.ok) throw new Error(await res.text())
  return res.json()
}

/** Fetch helper that returns the raw Response (caller checks res.ok). */
export function authFetch(url: string) {
  const token = getToken()
  return fetch(url, {
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    credentials: "include",
  })
}
