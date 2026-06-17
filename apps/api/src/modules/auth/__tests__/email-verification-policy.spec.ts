import { requiresEmailVerification, __EXEMPT_POST_PATHS } from "../email-verification-policy"

function req(method: string, path: string) {
  return { method, path }
}

describe("requiresEmailVerification (Phase 7.8 #25 policy)", () => {
  describe("read methods are exempt", () => {
    for (const method of ["GET", "HEAD", "OPTIONS"]) {
      it(`${method} /api/v1/orders → does NOT require verification`, () => {
        expect(requiresEmailVerification(req(method, "/api/v1/orders"))).toBe(false)
      })
    }
  })

  describe("state-changing methods on customer routes require verification", () => {
    const customerPaths = [
      "/api/v1/orders",
      "/api/v1/orders/abc123/dispute",
      "/api/v1/support/tickets",
      "/api/v1/publisher-payouts/withdrawals",
    ]
    for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
      for (const path of customerPaths) {
        it(`${method} ${path} → DOES require verification`, () => {
          expect(requiresEmailVerification(req(method, path))).toBe(true)
        })
      }
    }
  })

  describe("EXEMPT_POST_PATHS — locked-out user can still escape the lockout", () => {
    it("POST /api/v1/auth/sign-out is exempt (user can sign out)", () => {
      expect(requiresEmailVerification(req("POST", "/api/v1/auth/sign-out"))).toBe(false)
    })
    it("POST /api/v1/auth/send-verification-email is exempt (user can resend)", () => {
      expect(requiresEmailVerification(req("POST", "/api/v1/auth/send-verification-email"))).toBe(false)
    })
    it("POST /api/v1/users/me/resend-verification is exempt (future endpoint)", () => {
      expect(requiresEmailVerification(req("POST", "/api/v1/users/me/resend-verification"))).toBe(false)
    })
  })

  describe("policy sanity", () => {
    it("EXEMPT_POST_PATHS contains exactly the documented entries", () => {
      // Drift guard — if someone adds an exemption without updating the
      // PR description's "## GET-mutation audit" section, this fails.
      expect(__EXEMPT_POST_PATHS).toHaveLength(2)
    })
  })
})
