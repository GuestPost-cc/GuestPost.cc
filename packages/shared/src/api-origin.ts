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

function validDnsHostname(hostname: string): boolean {
  if (!hostname || hostname.length > 253) return false
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false

  const labels = hostname.split(".")
  return (
    labels.length >= 2 &&
    labels.every((label) =>
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label),
    )
  )
}

function instanceDomainForHostname(hostname: string): string | null {
  const normalized = normalizedHostname(hostname).replace(/\.$/, "")
  if (isLoopbackHostname(normalized)) return null
  if (!validDnsHostname(normalized)) return null

  const labels = normalized.split(".")
  // Two-label hosts are treated as the configured instance domain even if
  // their first label happens to match a service name (for example app.com).
  if (labels.length > 2 && SERVICE_HOST_LABELS.has(labels[0])) labels.shift()
  return labels.join(".")
}

function allowedInstanceDomains(
  configuredDomains: string | readonly string[] | undefined,
): Set<string> {
  const configured =
    typeof configuredDomains === "string"
      ? configuredDomains.split(",")
      : (configuredDomains ?? [])
  return new Set(
    configured
      .map((domain) => normalizedHostname(domain).replace(/\.$/, ""))
      .filter(validDnsHostname),
  )
}

function apiOriginForHostname(
  hostname: string,
  allowedDomains: Set<string>,
): string | null {
  const instanceDomain = instanceDomainForHostname(hostname)
  if (!instanceDomain || !allowedDomains.has(instanceDomain)) return null
  return `https://api.${instanceDomain}`
}

export interface ResolveApiOriginOptions {
  configuredUrl?: string | null
  allowedAppDomains?: string | readonly string[]
  browserLocation?: { hostname: string; protocol: string } | null
  nodeEnv?: string
}

export type InstanceSurface = "website" | "portal" | "publisher" | "admin"

export interface ResolveInstanceOriginOptions {
  configuredUrl?: string | null
  allowedAppDomains?: string | readonly string[]
  browserLocation?: { hostname: string; protocol: string } | null
  nodeEnv?: string
}

function parseConfiguredInstanceOrigin(value: string): string {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("Configured app URL must be a valid absolute URL")
  }
  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    (url.pathname !== "" && url.pathname !== "/")
  ) {
    throw new Error(
      "Configured app URL cannot contain credentials, a path, query, or fragment",
    )
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Configured app URL must use HTTPS or loopback HTTP")
  }
  if (url.protocol === "http:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("Configured app URL may use HTTP only for loopback hosts")
  }
  return url.origin
}

/**
 * Resolve another surface in this deployment only when the active hostname's
 * instance domain is explicitly allow-listed. Otherwise use the configured
 * destination, preserving safe behavior on preview and third-party hosts.
 */
export function resolveInstanceOrigin(
  surface: InstanceSurface,
  options: ResolveInstanceOriginOptions = {},
): string {
  const location = options.browserLocation ?? null
  const allowedDomains = allowedInstanceDomains(
    options.allowedAppDomains ?? process.env.NEXT_PUBLIC_ALLOWED_APP_DOMAINS,
  )
  const domain = location ? instanceDomainForHostname(location.hostname) : null
  if (domain && allowedDomains.has(domain)) {
    return surface === "website"
      ? `https://${domain}`
      : `https://${surface === "portal" ? "app" : surface}.${domain}`
  }

  const configuredUrl = options.configuredUrl?.trim()
  if (configuredUrl) return parseConfiguredInstanceOrigin(configuredUrl)

  if (
    options.nodeEnv === "production" ||
    location?.protocol === "https:" ||
    (location && !isLoopbackHostname(location.hostname))
  ) {
    throw new Error(
      "A configured app URL is required for an unrecognized or production host",
    )
  }
  const port =
    surface === "website"
      ? 3000
      : surface === "portal"
        ? 3001
        : surface === "publisher"
          ? 3002
          : 3003
  return `http://localhost:${port}`
}

/**
 * Accept a browser-provided origin only when it is the exact, allow-listed
 * origin for the requested application surface.
 */
export function resolveRequestInstanceOrigin(
  surface: InstanceSurface,
  requestOrigin: string | undefined,
  options: ResolveInstanceOriginOptions = {},
): string | null {
  if (!requestOrigin) return null
  try {
    const url = new URL(requestOrigin)
    if (url.origin !== requestOrigin) return null
    const resolved = resolveInstanceOrigin(surface, {
      ...options,
      browserLocation: { hostname: url.hostname, protocol: url.protocol },
    })
    return resolved === url.origin ? resolved : null
  } catch {
    return null
  }
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
  const allowedDomains = allowedInstanceDomains(
    options.allowedAppDomains ?? process.env.NEXT_PUBLIC_ALLOWED_APP_DOMAINS,
  )
  // App/API hosts follow a shared pattern across deployments: frontends use
  // the instance domain (or a known service subdomain) and the API uses
  // api.<instance-domain>. Derive it at request time, not from a build-time
  // hostname, so custom domains and aliases keep using their matching API.
  const domainApiOrigin =
    location && apiOriginForHostname(location.hostname, allowedDomains)
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
