import { CURRENT_TERMS_VERSION } from "@guestpost/shared"
import { validateAuthRequest } from "../request-validation"

describe("validateAuthRequest", () => {
  it("rejects empty login credentials", () => {
    expect(
      validateAuthRequest("/sign-in/email", { email: "", password: "" }),
    ).toEqual({
      success: false,
      message: "Email address is required",
    })
  })

  it("requires Terms acceptance for email signup", () => {
    expect(
      validateAuthRequest("/sign-up/email", {
        name: "Jane Smith",
        email: "jane@example.com",
        password: "secure-password",
        termsAccepted: false,
        termsVersion: CURRENT_TERMS_VERSION,
      }),
    ).toEqual({
      success: false,
      message: "You must accept the Terms of Service",
    })
  })

  it("returns normalized signup data for a valid request", () => {
    expect(
      validateAuthRequest("/sign-up/email", {
        name: "  Jane Smith  ",
        email: "  jane@example.com  ",
        password: "secure-password",
        termsAccepted: true,
        termsVersion: CURRENT_TERMS_VERSION,
      }),
    ).toEqual({
      success: true,
      data: {
        name: "Jane Smith",
        email: "jane@example.com",
        password: "secure-password",
        termsAccepted: true,
        termsVersion: CURRENT_TERMS_VERSION,
      },
    })
  })

  it("rejects a stale or missing Terms version", () => {
    expect(
      validateAuthRequest("/sign-up/email", {
        name: "Jane Smith",
        email: "jane@example.com",
        password: "secure-password",
        termsAccepted: true,
        termsVersion: "2025-01-01",
      }),
    ).toEqual({
      success: false,
      message:
        "Accept the current Terms of Service before creating an account.",
    })
  })

  it("rejects an empty forgot-password email", () => {
    expect(
      validateAuthRequest("/request-password-reset", { email: "   " }),
    ).toEqual({
      success: false,
      message: "Email address is required",
    })
  })

  it("ignores unrelated Better Auth routes", () => {
    expect(validateAuthRequest("/get-session", {})).toBeNull()
  })
})
