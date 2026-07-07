import { createAuthClient } from "better-auth/react"

function getBaseUrl(): string {
  const envUrl =
    typeof process !== "undefined"
      ? process.env?.NEXT_PUBLIC_API_URL
      : undefined
  if (envUrl) return envUrl
  if (typeof window !== "undefined") {
    const host = window.location.hostname
    if (host !== "localhost" && host !== "127.0.0.1")
      return `http://${host}:4000`
  }
  return "http://localhost:4000"
}

export const authClient = createAuthClient({
  baseURL: getBaseUrl(),
  basePath: "/api/v1/auth",
  appURL: typeof window !== "undefined" ? window.location.origin : undefined,
})
