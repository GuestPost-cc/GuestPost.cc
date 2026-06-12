// Canonical URL normalization. Used for delivery target-URL matching and fraud
// dedupe — comparisons must be done on normalized values, never raw strings.
// Pure (uses WHATWG URL), safe to bundle anywhere.
//
// Normalizes: protocol + host casing, default-port removal, trailing slash,
// query-param ordering, fragment removal. Percent-encoding is normalized by the
// URL parser. Does NOT strip www (a link to www.x.com vs x.com is a real
// difference the publisher controls); domain-level fraud checks handle host.

export function normalizeUrl(raw: string): string {
  let u: URL
  try {
    u = new URL(raw.trim())
  } catch {
    return raw.trim().toLowerCase()
  }

  u.protocol = u.protocol.toLowerCase()
  u.hostname = u.hostname.toLowerCase()

  // Drop default ports
  if ((u.protocol === "http:" && u.port === "80") || (u.protocol === "https:" && u.port === "443")) {
    u.port = ""
  }

  // Sort query params for stable comparison
  if (u.searchParams && [...u.searchParams.keys()].length > 0) {
    const sorted = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    const next = new URLSearchParams()
    for (const [k, v] of sorted) next.append(k, v)
    u.search = next.toString()
  } else {
    u.search = ""
  }

  // Drop fragment — not part of resource identity for link matching
  u.hash = ""

  // Normalize path: collapse trailing slash (but keep root "/")
  let path = u.pathname
  if (path.length > 1 && path.endsWith("/")) path = path.replace(/\/+$/, "")
  u.pathname = path || "/"

  let out = u.toString()
  // URL.toString re-adds a trailing slash for empty path; strip it for non-root
  if (out.endsWith("/") && u.pathname === "/" && !u.search) {
    out = out.slice(0, -1)
  }
  return out
}

// Exact normalized equality (target-URL match requires this).
export function urlsMatch(a: string, b: string): boolean {
  return normalizeUrl(a) === normalizeUrl(b)
}

// Registrable host compare, ignoring www. Used for domain-mismatch fraud checks.
export function sameDomain(a: string, b: string): boolean {
  try {
    const ha = new URL(a).hostname.toLowerCase().replace(/^www\./, "")
    const hb = new URL(b).hostname.toLowerCase().replace(/^www\./, "")
    return ha === hb
  } catch {
    return false
  }
}
