import { createHmac, timingSafeEqual } from "crypto"

let warnedFallback = false

function getSecret(): string {
  const secret = process.env.QUEUE_SIGNING_SECRET
  if (secret) return secret

  // Production must use a dedicated secret — sharing JWT_SECRET couples
  // queue trust to auth token trust
  if (process.env.NODE_ENV === "production") {
    throw new Error("QUEUE_SIGNING_SECRET must be set in production to sign queue jobs")
  }

  const fallback = process.env.JWT_SECRET
  if (!fallback) {
    throw new Error("QUEUE_SIGNING_SECRET (or JWT_SECRET in development) must be set to sign queue jobs")
  }
  if (!warnedFallback) {
    warnedFallback = true
    console.warn("[job-signing] QUEUE_SIGNING_SECRET not set — falling back to JWT_SECRET (development only)")
  }
  return fallback
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`)
  return `{${entries.join(",")}}`
}

export function signJobPayload<T extends Record<string, unknown>>(data: T): T & { signature: string } {
  const signature = createHmac("sha256", getSecret()).update(canonicalize(data)).digest("hex")
  return { ...data, signature }
}

export function verifyJobPayload(data: Record<string, unknown> | null | undefined): boolean {
  if (!data || typeof data !== "object") return false
  const { signature, ...payload } = data as Record<string, unknown> & { signature?: string }
  if (typeof signature !== "string" || signature.length !== 64) return false
  const expected = createHmac("sha256", getSecret()).update(canonicalize(payload)).digest("hex")
  try {
    return timingSafeEqual(Buffer.from(signature, "hex"), Buffer.from(expected, "hex"))
  } catch {
    return false
  }
}
