import { createApiClient } from "@guestpost/api-client"

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000"

export const api = createApiClient({ baseUrl: API_URL })
