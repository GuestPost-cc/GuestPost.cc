// Node-only DNS TXT lookup for domain-ownership verification.
//
// Kept OUT of the package index (./index.ts) on purpose: it imports node `dns`,
// which has no browser fallback and breaks the Next.js client bundles. The
// worker imports it directly via "@guestpost/shared/dist/dns-lookup".
import { promises as dns } from "dns"
import { verificationTxtValue, candidateHostnames, DnsCheckResult } from "./dns-verification"

// Resolves TXT records for the root + www variant and looks for the exact
// expected value. TXT records can be split into multiple strings by the DNS
// server — Node returns string[][]; join each record's chunks before compare.
// Bounded by a timeout so a slow/hostile resolver can't hang the worker.
export async function checkDnsTxtToken(
  websiteUrl: string,
  token: string,
  opts: { timeoutMs?: number } = {},
): Promise<DnsCheckResult> {
  const expected = verificationTxtValue(token)
  const hosts = candidateHostnames(websiteUrl)
  if (hosts.length === 0) return { found: false, matchedHost: null, reason: "Invalid website URL" }

  const timeoutMs = opts.timeoutMs ?? 8000
  let sawAnyRecord = false
  const errors: string[] = []

  for (const host of hosts) {
    let records: string[][]
    try {
      records = await withTimeout(dns.resolveTxt(host), timeoutMs)
    } catch (err: any) {
      // ENODATA/ENOTFOUND = no TXT on that host; keep trying the next variant
      errors.push(`${host}: ${err?.code ?? err?.message ?? "lookup failed"}`)
      continue
    }
    for (const chunks of records) {
      sawAnyRecord = true
      const joined = chunks.join("").trim()
      if (joined === expected) {
        return { found: true, matchedHost: host, reason: null }
      }
    }
  }

  if (!sawAnyRecord) {
    return { found: false, matchedHost: null, reason: `No TXT record found (${errors.join("; ") || "checked root + www"})` }
  }
  return { found: false, matchedHost: null, reason: "TXT records present but none match the verification token" }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<T>((_, reject) => {
    timer = setTimeout(() => reject(new Error("DNS lookup timed out")), ms)
  })
  // Clear the timer once the race settles so no dangling timeout keeps the
  // event loop alive (also avoids a leak warning in tests).
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer))
}
