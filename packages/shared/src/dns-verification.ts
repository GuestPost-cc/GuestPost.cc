// DNS TXT domain-ownership verification — token format + helpers. Pure, no
// framework deps and (deliberately) no node `dns` import so this module is safe
// to bundle into browser apps. The actual TXT lookup lives in ./dns-lookup
// (node-only) and is NOT re-exported from the package index.
export const VERIFICATION_TXT_PREFIX = "guestpost-verification"

// 32 bytes entropy, URL-safe base64url, no padding.
// Uses Web Crypto API (globalThis.crypto.getRandomValues) instead of
// node:crypto so this module stays browser-bundle-safe.
export function generateVerificationToken(): string {
  const bytes = new Uint8Array(32)
  globalThis.crypto.getRandomValues(bytes)
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
}

export function verificationTxtValue(token: string): string {
  return `${VERIFICATION_TXT_PREFIX}=${token}`
}

// Extract the apex (root) domain candidate + www variant from a website URL.
// Returns lowercased hostnames with no port. Falsy input → empty list.
export function candidateHostnames(websiteUrl: string): string[] {
  let host: string
  try {
    host = new URL(websiteUrl).hostname.toLowerCase()
  } catch {
    // Bare hostname fallback
    host = String(websiteUrl)
      .trim()
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .split("/")[0]
      .split(":")[0]
  }
  if (!host) return []
  const root = host.replace(/^www\./, "")
  const set = new Set([root, `www.${root}`])
  return [...set]
}

export interface DnsCheckResult {
  found: boolean
  // Hostname the record was found on (for audit), or null
  matchedHost: string | null
  // Human reason when not found
  reason: string | null
}
