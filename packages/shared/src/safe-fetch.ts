// Phase 7.11 — SSRF + DoS hardening for worker fetches.
//
// Lifts two duplicated helpers out of
// apps/worker/src/processors/{delivery-verification,verification}.processor.ts
// into a single shared module. Adds two protections beyond the originals:
//
//   1. DNS-rebinding-resistant fetch. The legacy isSafePublicUrl only
//      checked the hostname literally — `fetch()` resolved DNS later, so
//      an attacker-controlled A record that returned a public IP at
//      check time and 169.254.169.254 (AWS metadata) at fetch time
//      bypassed the guard (TOCTOU). The undici Agent below resolves DNS
//      inside the connection callback and binds the connection to the
//      validated IP — no gap to exploit.
//
//   2. Response-body size cap. The legacy code did `await res.text()`
//      with no limit. A 1GB malicious response at concurrency 4 OOMs
//      the worker pod. readBodyWithCap streams the body and cancels
//      the reader on overrun.
//
// Validation logic for resolved addresses lives in the pure
// validateResolvedAddress() function so it's unit-testable without
// undici/dns mocking — the Agent's lookup callback is a thin wrapper.

import { isIP } from "net"
import dns from "dns"
import { Agent, fetch as undiciFetch } from "undici"

// Single source of truth for private-IP patterns. Includes IPv4-mapped
// IPv6 forms (e.g. ::ffff:127.0.0.1) that the original list missed.
export const PRIVATE_IP_PATTERNS = [
  /^127\./, /^10\./, /^192\.168\./, /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./, /^0\./,
  /^::1$/, /^f[cd]/i, /^fe80:/i,
  /^::ffff:127\./i, /^::ffff:10\./i, /^::ffff:192\.168\./i,
  /^::ffff:169\.254\./i, /^::ffff:172\.(1[6-9]|2\d|3[01])\./i,
  /^::ffff:0\./i,
]

export type SafeFetchErrorCode =
  | "UNSAFE_URL"        // protocol / host pattern / literal-private-IP fail
  | "DNS_REBINDING"     // hostname resolved to a private IP
  | "DNS_LOOKUP_FAILED" // hostname couldn't resolve at all
  | "BODY_TOO_LARGE"    // response body exceeded the cap

export class SafeFetchError extends Error {
  constructor(public code: SafeFetchErrorCode, message: string) {
    super(message)
    this.name = "SafeFetchError"
  }
}

/**
 * Pre-flight check on the URL string itself. Catches obvious bad
 * inputs (non-http(s) protocols, literal private IPs, internal-network
 * hostnames) before any DNS resolution.
 */
export function isSafePublicUrl(rawUrl: string): boolean {
  let url: URL
  try { url = new URL(rawUrl) } catch { return false }
  if (url.protocol !== "http:" && url.protocol !== "https:") return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) return false
  if (isIP(host) && PRIVATE_IP_PATTERNS.some((p) => p.test(host))) return false
  return true
}

/**
 * Pure validator: given a hostname and the IP address it resolved to,
 * returns null if the address is acceptable, or a SafeFetchError if
 * the address falls in any private range. Lives outside the Agent
 * wiring so it's testable without undici / dns mocking — the lookup
 * callback below is a thin wrapper that just delegates here.
 */
export function validateResolvedAddress(hostname: string, address: string): SafeFetchError | null {
  if (!address) return null
  if (PRIVATE_IP_PATTERNS.some((p) => p.test(address))) {
    return new SafeFetchError(
      "DNS_REBINDING",
      `hostname ${hostname} resolved to private IP ${address}`,
    )
  }
  return null
}

// Single shared Agent — undici instantiates the connection pool inside.
// Per-fetch instantiation would defeat the connection-reuse benefit.
// The lookup callback is intentionally minimal — all validation logic
// lives in validateResolvedAddress() above for direct unit-testability.
const SAFE_LOOKUP_AGENT = new Agent({
  connect: {
    // Per-connection DNS resolution. undici binds the connection to
    // the IP this returns — no TOCTOU gap. If the DNS server later
    // changes the A record, the next connection re-resolves, but the
    // in-flight connection stays pinned to the validated IP.
    lookup: (hostname, options, callback) => {
      // Force single-address resolution — the dispatcher binds the
      // connection to one IP, so we don't need the array overload.
      dns.lookup(hostname, { ...options, all: false }, (err, address, family) => {
        if (err) return callback(err, "", 0)
        // With all: false, address is always a string (the overload's
        // array form requires all: true).
        const addr = address as string
        const violation = validateResolvedAddress(hostname, addr)
        if (violation) return callback(violation, "", 0)
        callback(null, addr, family as number)
      })
    },
  },
})

/**
 * Fetches a URL with SSRF + DNS-rebinding protection. Throws
 * SafeFetchError("UNSAFE_URL") on the pre-flight rejection; throws
 * SafeFetchError("DNS_REBINDING") if the connection callback rejects
 * a resolved private IP. Otherwise behaves like the global fetch.
 *
 * Caller is responsible for reading the body — use readBodyWithCap
 * to enforce a size limit.
 */
export async function safeFetch(rawUrl: string, init?: RequestInit): Promise<Response> {
  if (!isSafePublicUrl(rawUrl)) {
    throw new SafeFetchError("UNSAFE_URL", `URL failed pre-flight safety check: ${rawUrl}`)
  }
  return (await undiciFetch(rawUrl, {
    ...(init as any),
    dispatcher: SAFE_LOOKUP_AGENT,
  })) as unknown as Response
}

/**
 * Reads a Response body with a hard byte cap. Throws SafeFetchError
 * (BODY_TOO_LARGE) if exceeded. Decodes UTF-8 across chunk boundaries
 * via TextDecoder's streaming mode. Cancels the underlying connection
 * on overrun.
 */
export async function readBodyWithCap(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return ""
  const reader = res.body.getReader()
  const decoder = new TextDecoder("utf-8")
  let total = 0
  let out = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel().catch(() => {})
        throw new SafeFetchError("BODY_TOO_LARGE", `response body exceeded ${maxBytes} bytes`)
      }
      out += decoder.decode(value, { stream: true })
    }
    out += decoder.decode()
    return out
  } finally {
    reader.releaseLock?.()
  }
}
