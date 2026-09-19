import {
  sanitizeClientCallbackUrl,
  sanitizeClientReturnTo,
} from "../client/safe-redirect"

describe("client redirect sanitization", () => {
  it.each([
    "https://attacker.example",
    "//attacker.example",
    "/\\attacker.example",
  ])("rejects external return target %s", (value) => {
    expect(sanitizeClientReturnTo(value)).toBe("/dashboard")
  })

  it("preserves an application-relative path", () => {
    expect(sanitizeClientReturnTo("/dashboard/orders?tab=open#item")).toBe(
      "/dashboard/orders?tab=open#item",
    )
  })

  it("uses a relative callback fallback outside the browser", () => {
    expect(
      sanitizeClientCallbackUrl("https://attacker.example", "/login"),
    ).toBe("/login")
  })
})
