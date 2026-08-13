import { createApiClient, resolveApiOrigin } from "@guestpost/api-client"

const API_URL = resolveApiOrigin({
  configuredUrl: process.env.NEXT_PUBLIC_API_URL,
  nodeEnv: process.env.NODE_ENV,
})

export const api = createApiClient({ baseUrl: API_URL })
