import { hasAuthCredentials } from "../has-auth-credentials"

// Captured-shape fixture: a real Better Auth signed cookie value has the
// shape `<opaque-token>.<base64-HMAC-SHA256>` then URL-encoded. The token
// segment is a long URL-safe random string; the HMAC segment is standard
// base64 (44 chars including `=` padding). This sample uses a synthetic
// 32-char token + a synthetic 44-char base64 sig — same shape, no real
// secret material.
const REAL_SHAPED_TOKEN = "a".repeat(32)
const REAL_SHAPED_SIG = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnop=="
const REAL_SHAPED_VALUE = `${REAL_SHAPED_TOKEN}.${REAL_SHAPED_SIG}`
const REAL_SHAPED_VALUE_URL_ENCODED = encodeURIComponent(REAL_SHAPED_VALUE)

function req(opts: { authorization?: string; cookie?: string }) {
  return { headers: opts }
}

describe("hasAuthCredentials", () => {
  describe("Bearer token", () => {
    it("returns true for any Bearer authorization header", () => {
      expect(hasAuthCredentials(req({ authorization: "Bearer abc.def" }))).toBe(true)
    })
    it("returns false for non-Bearer authorization", () => {
      expect(hasAuthCredentials(req({ authorization: "Basic dXNlcjpwYXNz" }))).toBe(false)
    })
  })

  describe("session cookie shape — junk rejected (audit §5.8 sub-finding)", () => {
    it("rejects the trivial bypass: `guestpost-session_token=anything`", () => {
      expect(hasAuthCredentials(req({ cookie: "guestpost-session_token=anything" }))).toBe(false)
    })
    it("rejects an empty value", () => {
      expect(hasAuthCredentials(req({ cookie: "guestpost.session_token=" }))).toBe(false)
    })
    it("rejects a single-segment value (no `.` separator)", () => {
      expect(hasAuthCredentials(req({ cookie: `guestpost.session_token=${REAL_SHAPED_TOKEN}` }))).toBe(false)
    })
    it("rejects a too-short token half", () => {
      expect(hasAuthCredentials(req({ cookie: `guestpost.session_token=abc.${REAL_SHAPED_SIG}` }))).toBe(false)
    })
    it("rejects a too-short sig half", () => {
      expect(hasAuthCredentials(req({ cookie: `guestpost.session_token=${REAL_SHAPED_TOKEN}.tooshort` }))).toBe(false)
    })
    it("rejects a missing cookie header entirely", () => {
      expect(hasAuthCredentials(req({}))).toBe(false)
    })
    it("rejects an unrelated cookie", () => {
      expect(hasAuthCredentials(req({ cookie: "sid=abc; foo=bar" }))).toBe(false)
    })
  })

  describe("session cookie shape — valid accepted", () => {
    it("accepts dot-form name (default Better Auth format)", () => {
      const cookie = `guestpost.session_token=${REAL_SHAPED_VALUE}`
      expect(hasAuthCredentials(req({ cookie }))).toBe(true)
    })
    it("accepts dash-form name (Better Auth fallback)", () => {
      const cookie = `guestpost-session_token=${REAL_SHAPED_VALUE}`
      expect(hasAuthCredentials(req({ cookie }))).toBe(true)
    })
    it("accepts URL-encoded value (transport form)", () => {
      const cookie = `guestpost.session_token=${REAL_SHAPED_VALUE_URL_ENCODED}`
      expect(hasAuthCredentials(req({ cookie }))).toBe(true)
    })
    it("accepts the cookie when it's one of many", () => {
      const cookie = `other=abc; guestpost.session_token=${REAL_SHAPED_VALUE}; trailing=xyz`
      expect(hasAuthCredentials(req({ cookie }))).toBe(true)
    })
  })

  describe("regression: original `cookie.includes('guestpost-session')` check", () => {
    it("the trivial bypass that PASSED before Phase 7.8 now FAILS", () => {
      // Pre-Phase-7.8 code returned true for this. The whole point of the
      // sub-finding fix is that this no longer counts as authed credentials.
      expect(hasAuthCredentials(req({ cookie: "guestpost-session=garbage" }))).toBe(false)
    })
  })
})
