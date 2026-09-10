export const API_KEY_PERMISSIONS = [
  "orders:read",
  "orders:write",
  "reports:read",
  "reports:write",
] as const

export type ApiKeyPermission = (typeof API_KEY_PERMISSIONS)[number]

export function isApiKeyPermission(value: unknown): value is ApiKeyPermission {
  return (
    typeof value === "string" &&
    (API_KEY_PERMISSIONS as readonly string[]).includes(value)
  )
}
