const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"])
const SERVICE_HOST_LABELS = new Set([
  "admin",
  "api",
  "app",
  "portal",
  "publisher",
  "www",
])

function normalizedHostname(value: string): string {
  const hostname = value.trim().toLowerCase()
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname
}

function isLoopbackHostname(value: string): boolean {
  return LOOPBACK_HOSTS.has(normalizedHostname(value))
}

/**
 * Read the hostname from an HTTP Host authority without accepting a URL,
 * forwarded-host list, or userinfo. Reverse proxies may leave the public Host
 * header intact while Next.js' request URL reflects an internal authority.
 */
export function hostnameFromHostHeader(
  value: string | null | undefined,
): string | null {
  if (!value || value.length > 255 || /[\s,/@?#\\]/.test(value)) return null

  try {
    const url = new URL(`https://${value}`)
    if (
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    ) {
      return null
    }
    return url.hostname
  } catch {
    return null
  }
}

function apiOriginForHostname(hostname: string): string | null {
  const normalized = normalizedHostname(hostname).replace(/\.$/, "")
  if (isLoopbackHostname(normalized)) return null
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(normalized)) return null

  const labels = normalized.split(".").filter(Boolean)
  if (labels.length < 2) return null
  if (
    labels.some(
      (label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  ) {
    return null
  }
  // Two-label hosts are treated as the configured instance domain even if
  // their first label happens to match a service name (for example app.com).
  if (labels.length > 2 && SERVICE_HOST_LABELS.has(labels[0])) labels.shift()
  if (labels.length < 2) return null

  return `https://api.${labels.join(".")}`
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
  const runtimeWindow = (
    globalThis as unknown as {
      window?: { location: { hostname: string; protocol: string } }
    }
  ).window
  const location = options.browserLocation ?? runtimeWindow?.location ?? null
  // App/API hosts follow a shared pattern across deployments: frontends use
  // the instance domain (or a known service subdomain) and the API uses
  // api.<instance-domain>. Derive it at request time, not from a build-time
  // hostname, so custom domains and aliases keep using their matching API.
  const domainApiOrigin = location && apiOriginForHostname(location.hostname)
  if (domainApiOrigin) return domainApiOrigin

  const configuredUrl = options.configuredUrl?.trim()
  if (configuredUrl) return parseConfiguredOrigin(configuredUrl)

  if (location && !isLoopbackHostname(location.hostname)) {
    throw new Error(
      "NEXT_PUBLIC_API_URL is required for an unrecognized non-loopback browser host",
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
