/**
 * Phase 7.8 #27 — job-signing `iat` freshness check.
 *
 * Imports from source (not dist) so the test reflects in-flight edits
 * without needing a rebuild of @guestpost/shared.
 */
import {
  signJobPayload,
  verifyJobPayload,
  SIGNED_PAYLOAD_VERSION,
} from "@guestpost/shared"

const ORIGINAL_SECRET = process.env.QUEUE_SIGNING_SECRET
beforeAll(() => {
  process.env.QUEUE_SIGNING_SECRET = "test-secret-phase-7-8"
})
afterAll(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.QUEUE_SIGNING_SECRET
  else process.env.QUEUE_SIGNING_SECRET = ORIGINAL_SECRET
})

describe("Phase 7.8 #27 — job-signing iat + replay protection", () => {
  describe("signJobPayload injects iat + v=1", () => {
    it("adds iat as a recent Unix ms timestamp", () => {
      const before = Date.now()
      const signed = signJobPayload({ foo: "bar" })
      const after = Date.now()
      expect(signed.iat).toBeGreaterThanOrEqual(before)
      expect(signed.iat).toBeLessThanOrEqual(after)
    })
    it("adds v: 1 (schema version)", () => {
      const signed = signJobPayload({ foo: "bar" })
      expect(signed.v).toBe(SIGNED_PAYLOAD_VERSION)
      expect(signed.v).toBe(1)
    })
    it("includes signature (64-char hex)", () => {
      const signed = signJobPayload({ foo: "bar" })
      expect(signed.signature).toMatch(/^[a-f0-9]{64}$/)
    })
    it("preserves original payload fields", () => {
      const signed = signJobPayload({ foo: "bar", n: 42 })
      expect(signed.foo).toBe("bar")
      expect(signed.n).toBe(42)
    })
  })

  describe("verifyJobPayload — fresh payload accepted", () => {
    it("accepts a just-signed payload with default 24h window", () => {
      const signed = signJobPayload({ foo: "bar" })
      expect(verifyJobPayload(signed)).toBe(true)
    })
    it("accepts a 1h-old payload (well within 24h default)", () => {
      const signed = signJobPayload({ foo: "bar" })
      signed.iat = Date.now() - 60 * 60 * 1000
      // Re-sign with the tampered iat so HMAC stays valid.
      const resigned = signJobPayload({ foo: "bar" })
      resigned.iat = signed.iat
      // Easier: just sign at past time by mocking Date.now temporarily.
      const realNow = Date.now
      jest.spyOn(Date, "now").mockReturnValue(realNow() - 60 * 60 * 1000)
      const past = signJobPayload({ foo: "bar" })
      ;(Date.now as jest.Mock).mockRestore()
      expect(verifyJobPayload(past)).toBe(true)
    })
  })

  describe("verifyJobPayload — stale payload rejected", () => {
    it("rejects a payload older than the default 24h window", () => {
      const realNow = Date.now()
      jest.spyOn(Date, "now").mockReturnValue(realNow - 25 * 60 * 60 * 1000)
      const old = signJobPayload({ foo: "bar" })
      ;(Date.now as jest.Mock).mockRestore()
      expect(verifyJobPayload(old)).toBe(false)
    })
    it("rejects a payload older than a custom maxAgeMs", () => {
      const realNow = Date.now()
      jest.spyOn(Date, "now").mockReturnValue(realNow - 2 * 60 * 1000)
      const old = signJobPayload({ foo: "bar" })
      ;(Date.now as jest.Mock).mockRestore()
      expect(verifyJobPayload(old, { maxAgeMs: 60 * 1000 })).toBe(false) // 1m window, payload is 2m old
    })
  })

  describe("verifyJobPayload — future-dated payload rejected (clock attack defense)", () => {
    it("rejects a payload with iat far in the future (>60s skew tolerance)", () => {
      const realNow = Date.now()
      jest.spyOn(Date, "now").mockReturnValue(realNow + 5 * 60 * 1000)
      const future = signJobPayload({ foo: "bar" })
      ;(Date.now as jest.Mock).mockRestore()
      expect(verifyJobPayload(future)).toBe(false)
    })
    it("accepts a payload with iat within the 60s NTP-skew tolerance", () => {
      const realNow = Date.now()
      jest.spyOn(Date, "now").mockReturnValue(realNow + 30 * 1000) // 30s ahead, well within 60s tolerance
      const future = signJobPayload({ foo: "bar" })
      ;(Date.now as jest.Mock).mockRestore()
      expect(verifyJobPayload(future)).toBe(true)
    })
  })

  describe("verifyJobPayload — allowMissingIat rollout escape hatch", () => {
    // Simulate a pre-Phase-7.8 payload by re-implementing the legacy
    // sign-without-iat path. We can't reach the new signJobPayload to
    // produce such a payload, so build it manually with the same HMAC.
    function signLegacy(data: Record<string, unknown>): Record<string, unknown> & { signature: string } {
      // Re-use canonicalize via a stable JSON.stringify with sorted keys.
      const { createHmac } = require("crypto") as typeof import("crypto")
      const sorted = Object.keys(data).sort().reduce(
        (acc, k) => ({ ...acc, [k]: data[k] }),
        {} as Record<string, unknown>,
      )
      const canon = JSON.stringify(sorted)
      // Match canonicalize() format exactly: sorted keys, no undefined.
      // For flat {foo: "bar"} the canonical form is `{"foo":"bar"}` so
      // JSON.stringify of sorted suffices.
      const sig = createHmac("sha256", process.env.QUEUE_SIGNING_SECRET!).update(canon).digest("hex")
      return { ...data, signature: sig }
    }

    it("Deploy A default (allowMissingIat: true) accepts payloads with no iat", () => {
      const legacy = signLegacy({ foo: "bar" })
      expect(verifyJobPayload(legacy)).toBe(true)
    })
    it("Deploy B flip (allowMissingIat: false) rejects payloads with no iat", () => {
      const legacy = signLegacy({ foo: "bar" })
      expect(verifyJobPayload(legacy, { allowMissingIat: false })).toBe(false)
    })
  })

  describe("verifyJobPayload — repeatable bypass (maxAgeMs: 0)", () => {
    it("accepts an arbitrarily old payload when freshness is disabled", () => {
      const realNow = Date.now()
      jest.spyOn(Date, "now").mockReturnValue(realNow - 365 * 24 * 60 * 60 * 1000) // 1 year ago
      const ancient = signJobPayload({ foo: "bar" })
      ;(Date.now as jest.Mock).mockRestore()
      expect(verifyJobPayload(ancient, { maxAgeMs: 0 })).toBe(true)
    })
    it("still rejects on HMAC failure even with maxAgeMs: 0", () => {
      const signed = signJobPayload({ foo: "bar" })
      const tampered = { ...signed, foo: "tampered" }
      expect(verifyJobPayload(tampered, { maxAgeMs: 0 })).toBe(false)
    })
  })

  describe("verifyJobPayload — HMAC tampering rejected (regression)", () => {
    it("rejects when a non-iat field is tampered post-signing", () => {
      const signed = signJobPayload({ amount: 100 })
      const tampered = { ...signed, amount: 9999 }
      expect(verifyJobPayload(tampered)).toBe(false)
    })
    it("rejects when iat is tampered post-signing (iat is part of the digest)", () => {
      const signed = signJobPayload({ foo: "bar" })
      const tampered = { ...signed, iat: signed.iat - 60 * 60 * 1000 }
      expect(verifyJobPayload(tampered)).toBe(false)
    })
    it("rejects when v is tampered", () => {
      const signed = signJobPayload({ foo: "bar" })
      const tampered = { ...signed, v: 2 as any }
      expect(verifyJobPayload(tampered)).toBe(false)
    })
  })
})
