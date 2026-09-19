const SAFE_PATH = /^\/(?![\\/])/u

export function sanitizeClientReturnTo(
  value: unknown,
  fallback = "/dashboard",
): string {
  if (typeof value !== "string" || !SAFE_PATH.test(value)) return fallback

  try {
    const url = new URL(value, "https://guestpost.invalid")
    return url.origin === "https://guestpost.invalid"
      ? `${url.pathname}${url.search}${url.hash}`
      : fallback
  } catch {
    return fallback
  }
}

export function sanitizeClientCallbackUrl(
  value: unknown,
  fallbackPath: string,
): string {
  if (typeof window === "undefined")
    return sanitizeClientReturnTo(fallbackPath, "/")

  const fallback = new URL(
    sanitizeClientReturnTo(fallbackPath, "/"),
    window.location.origin,
  )
  if (typeof value !== "string") return fallback.toString()

  try {
    const url = new URL(value, window.location.origin)
    return url.origin === window.location.origin
      ? url.toString()
      : fallback.toString()
  } catch {
    return fallback.toString()
  }
}
