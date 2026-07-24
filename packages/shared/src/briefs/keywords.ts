export const TARGET_KEYWORD_LIMIT = 20
export const TARGET_KEYWORD_MAX_LENGTH = 80

export function normalizeTargetKeywordsInput(value: unknown): unknown {
  const values =
    typeof value === "string"
      ? value.split(/[,\n]/)
      : Array.isArray(value)
        ? value
        : value

  if (!Array.isArray(values)) return value

  const seen = new Set<string>()
  const normalized: unknown[] = []
  for (const candidate of values) {
    if (typeof candidate !== "string") {
      normalized.push(candidate)
      continue
    }
    const keyword = candidate.trim()
    if (!keyword) continue
    const identity = keyword.toLocaleLowerCase("en-US")
    if (seen.has(identity)) continue
    seen.add(identity)
    normalized.push(keyword)
  }
  return normalized
}
