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
