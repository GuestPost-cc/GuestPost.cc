export function normalizePropertyUrl(url: string): string {
  let normalized = url.replace(/^https?:\/\//, "")
  normalized = normalized.replace(/\/$/, "")
  normalized = normalized.replace(/^sc-domain:/, "")
  return normalized
}

export function isPropertyUrlMatch(url1: string, url2: string): boolean {
  return normalizePropertyUrl(url1) === normalizePropertyUrl(url2)
}
