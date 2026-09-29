import { getAllowedOrigins, isTrustedOrigin } from "./trusted-origins"

describe("trusted origins", () => {
  const originalCorsOrigin = process.env.CORS_ORIGIN
  const originalAllowedDomains = process.env.NEXT_PUBLIC_ALLOWED_APP_DOMAINS

  afterEach(() => {
    if (originalCorsOrigin === undefined) delete process.env.CORS_ORIGIN
    else process.env.CORS_ORIGIN = originalCorsOrigin
    if (originalAllowedDomains === undefined)
      delete process.env.NEXT_PUBLIC_ALLOWED_APP_DOMAINS
    else process.env.NEXT_PUBLIC_ALLOWED_APP_DOMAINS = originalAllowedDomains
  })

  it("allows only canonical frontend origins for configured instance domains", () => {
    process.env.CORS_ORIGIN = "https://legacy.example.com"
    process.env.NEXT_PUBLIC_ALLOWED_APP_DOMAINS =
      "stage.example.com, invalid/path, STAGE.EXAMPLE.COM."

    expect(getAllowedOrigins()).toEqual([
      "https://legacy.example.com",
      "https://stage.example.com",
      "https://app.stage.example.com",
      "https://publisher.stage.example.com",
      "https://admin.stage.example.com",
    ])
    expect(isTrustedOrigin("https://app.stage.example.com")).toBe(true)
    expect(isTrustedOrigin("https://attacker.stage.example.com")).toBe(false)
  })
})
