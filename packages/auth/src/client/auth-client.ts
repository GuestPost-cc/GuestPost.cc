import { resolveApiOrigin } from "@guestpost/shared"
import { createAuthClient } from "better-auth/react"

export function getAuthApiOrigin(): string {
  return resolveApiOrigin({
    configuredUrl:
      typeof process !== "undefined"
        ? process.env?.NEXT_PUBLIC_API_URL
        : undefined,
    browserLocation:
      typeof window !== "undefined" ? window.location : undefined,
    nodeEnv: typeof process !== "undefined" ? process.env?.NODE_ENV : undefined,
  })
}

export const authClient = createAuthClient({
  baseURL: getAuthApiOrigin(),
  basePath: "/api/v1/auth",
  appURL: typeof window !== "undefined" ? window.location.origin : undefined,
})
