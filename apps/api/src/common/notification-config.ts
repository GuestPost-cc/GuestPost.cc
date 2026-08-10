/** Safe numeric configuration for operational notification thresholds. */
export function notificationThreshold(
  envKey: string,
  fallback: number,
): number {
  const raw = process.env[envKey]
  if (raw === undefined || raw.trim() === "") return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) &&
    parsed >= 0 &&
    parsed <= Number.MAX_SAFE_INTEGER
    ? parsed
    : fallback
}

export function notificationFlag(envKey: string, fallback: boolean): boolean {
  const raw = process.env[envKey]?.trim().toLowerCase()
  if (raw === undefined || raw === "") return fallback
  if (raw === "true") return true
  if (raw === "false") return false
  return fallback
}
