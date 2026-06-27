import { createHmac, timingSafeEqual } from "node:crypto"

let warnedFallback = false

function getSecret(): string {
  const secret = process.env.QUEUE_SIGNING_SECRET
  if (secret) return secret

  // Production must use a dedicated secret — sharing JWT_SECRET couples
  // queue trust to auth token trust
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "QUEUE_SIGNING_SECRET must be set in production to sign queue jobs",
    )
  }

  const fallback = process.env.JWT_SECRET
  if (!fallback) {
    throw new Error(
      "QUEUE_SIGNING_SECRET (or JWT_SECRET in development) must be set to sign queue jobs",
    )
  }
  if (!warnedFallback) {
    warnedFallback = true
    console.warn(
      "[job-signing] QUEUE_SIGNING_SECRET not set — falling back to JWT_SECRET (development only)",
    )
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

// Phase 7.8 #27 — replay protection via issued-at + version.
// Both fields are part of the canonical digest, so they're tamper-proof.
// No nonce: the threat is a *leaked* signature replayed later, and a
// freshness window solves that without per-job Redis SET-NX overhead. If
// a real replay-during-window attack emerges, add nonces in a follow-up.
export const SIGNED_PAYLOAD_VERSION = 1 as const

// Default freshness window. Generous enough for the longest natural
// retry chains (delivery-verification's 60m × 3 = ~3h) without
// requiring per-queue overrides for typical use. Repeatable cron jobs
// must explicitly pass `maxAgeMs: 0` to bypass — their payload is
// signed once at worker boot and reused for every recurrence.
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000 // 24h

// Tolerates ~1 min of NTP drift between signer and verifier; catches
// payloads with grossly-future iat (malformed signer or clock attack).
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000

export interface VerifyOptions {
  /**
   * Max age in ms. 0 disables the freshness check (used by repeatable
   * cron jobs whose signed payload is reused across recurrences).
   * Default: 24h.
   */
  maxAgeMs?: number
  /**
   * Emergency-rollback opt-in. When true, payloads without an `iat`
   * field still verify (HMAC alone). Deploy B (2026-06-19+) ships
   * with the default `false`; pre-Phase-7.8 payloads (lacking `iat`)
   * had drained from all queues during the ≥48 h gap after Deploy A.
   * Pass `true` only as an explicit emergency rollback on a specific
   * processor — never as the global default again.
   */
  allowMissingIat?: boolean
}

const ROLLOUT_DEFAULTS: Required<VerifyOptions> = {
  maxAgeMs: DEFAULT_MAX_AGE_MS,
  allowMissingIat: false,
}

export function signJobPayload<T extends Record<string, unknown>>(
  data: T,
  iatOverride?: number,
): T & { signature: string; iat: number; v: typeof SIGNED_PAYLOAD_VERSION } {
  const enriched = {
    ...data,
    iat: iatOverride ?? Date.now(),
    v: SIGNED_PAYLOAD_VERSION,
  }
  const signature = createHmac("sha256", getSecret())
    .update(canonicalize(enriched))
    .digest("hex")
  return { ...enriched, signature }
}

export function verifyJobPayload(
  data: Record<string, unknown> | null | undefined,
  opts: VerifyOptions = {},
): boolean {
  if (!data || typeof data !== "object") return false
  const { signature, ...payload } = data as Record<string, unknown> & {
    signature?: string
  }
  if (typeof signature !== "string" || signature.length !== 64) return false
  const expected = createHmac("sha256", getSecret())
    .update(canonicalize(payload))
    .digest("hex")
  let hmacValid: boolean
  try {
    hmacValid = timingSafeEqual(
      Buffer.from(signature, "hex"),
      Buffer.from(expected, "hex"),
    )
  } catch {
    return false
  }
  if (!hmacValid) return false

  const maxAgeMs = opts.maxAgeMs ?? ROLLOUT_DEFAULTS.maxAgeMs
  if (maxAgeMs === 0) return true // explicit bypass — repeatable cron

  const allowMissingIat =
    opts.allowMissingIat ?? ROLLOUT_DEFAULTS.allowMissingIat
  const iat = (payload as { iat?: unknown }).iat
  if (typeof iat !== "number") return allowMissingIat

  const now = Date.now()
  if (iat > now + CLOCK_SKEW_TOLERANCE_MS) return false
  if (now - iat > maxAgeMs) return false
  return true
}
