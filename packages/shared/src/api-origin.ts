const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])

function normalizedHostname(value: string): string {
  const hostname = value.trim().toLowerCase()
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
}

function isLoopbackHostname(value: string): boolean {
  return LOOPBACK_HOSTS.has(normalizedHostname(value))
}

export interface ResolveApiOriginOptions {
  configuredUrl?: string | null
  browserLocation?: { hostname: string; protocol: string } | null
  nodeEnv?: string
}

function parseConfiguredOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("NEXT_PUBLIC_API_URL must be a valid absolute URL")
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error(
      "NEXT_PUBLIC_API_URL cannot contain credentials, a query, or a fragment",
    )
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("NEXT_PUBLIC_API_URL must use HTTPS or loopback HTTP")
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("NEXT_PUBLIC_API_URL may use HTTP only for loopback hosts")
  }
  const normalizedPath = url.pathname.replace(/\/+$/, "")
  if (normalizedPath && normalizedPath !== "/api/v1") {
    throw new Error(
      "NEXT_PUBLIC_API_URL must be an origin or end exactly in /api/v1",
    )
  }
  return url.origin
}

/**
 * Resolve the browser API authority once. Production-like hosts fail closed
 * without an explicit HTTPS origin; they never synthesize insecure :4000
 * mixed-content URLs from the page hostname.
 */
export function resolveApiOrigin(
  options: ResolveApiOriginOptions = {},
): string {
  const configuredUrl = options.configuredUrl?.trim()
  if (configuredUrl) return parseConfiguredOrigin(configuredUrl)

  const runtimeWindow = (
    globalThis as unknown as {
      window?: { location: { hostname: string; protocol: string } }
    }
  ).window
  const location = options.browserLocation ?? runtimeWindow?.location ?? null
  if (location && !isLoopbackHostname(location.hostname)) {
    throw new Error(
      "NEXT_PUBLIC_API_URL is required for a non-loopback browser host",
    )
  }
  if (location?.protocol === "https:") {
    throw new Error(
      "NEXT_PUBLIC_API_URL is required for an HTTPS browser origin",
    )
  }
  if (options.nodeEnv === "production") {
    throw new Error("NEXT_PUBLIC_API_URL is required in production")
  }
  return "http://localhost:4000"
}

export function apiV1Url(origin: string): string {
  return `${parseConfiguredOrigin(origin)}/api/v1`
}

export function resolveApiV1Url(options?: ResolveApiOriginOptions): string {
  return `${resolveApiOrigin(options)}/api/v1`
}
