import { BadRequestException } from "@nestjs/common"

// Normalizes a website URL to its dedupe key: lowercase hostname with the
// leading "www." stripped. "https://www.Site.com/path" and "http://site.com"
// both normalize to "site.com" — plain URL uniqueness misses these variants.
export function normalizeDomain(url: string): string {
  let parsed: URL
  try {
    parsed = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`)
  } catch {
    throw new BadRequestException(`Invalid website URL: ${url}`)
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "")
  if (!host || !host.includes(".")) {
    throw new BadRequestException(`Invalid website domain: ${url}`)
  }
  return host
}
