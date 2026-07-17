import { IntegrationsApiService } from "../integrations.service"

describe("IntegrationsApiService OAuth redirects", () => {
  const originalNodeEnv = process.env.NODE_ENV
  const originalPublisherUrl = process.env.NEXT_PUBLIC_PUBLISHER_URL
  const originalAdminUrl = process.env.NEXT_PUBLIC_ADMIN_URL

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    if (originalPublisherUrl === undefined)
      delete process.env.NEXT_PUBLIC_PUBLISHER_URL
    else process.env.NEXT_PUBLIC_PUBLISHER_URL = originalPublisherUrl
    if (originalAdminUrl === undefined) delete process.env.NEXT_PUBLIC_ADMIN_URL
    else process.env.NEXT_PUBLIC_ADMIN_URL = originalAdminUrl
  })

  function buildUrl(ownerType: "PUBLISHER" | "PLATFORM", returnUrl: string) {
    const service = Object.create(IntegrationsApiService.prototype) as any
    return service.buildFrontendReturnUrl(
      {
        ownerType,
        ownerId: "owner-1",
        provider: "GOOGLE_SEARCH_CONSOLE",
        nonce: "nonce",
        returnUrl,
        createdAt: new Date().toISOString(),
      },
      { connected: "account-1" },
    )
  }

  it("routes publisher and platform callbacks to their respective apps", () => {
    process.env.NODE_ENV = "production"
    process.env.NEXT_PUBLIC_PUBLISHER_URL = "https://publisher.example.com"
    process.env.NEXT_PUBLIC_ADMIN_URL = "https://admin.example.com"

    expect(buildUrl("PUBLISHER", "/dashboard/integrations")).toBe(
      "https://publisher.example.com/dashboard/integrations?connected=account-1",
    )
    expect(buildUrl("PLATFORM", "/dashboard/websites/site-1")).toBe(
      "https://admin.example.com/dashboard/websites/site-1?connected=account-1",
    )
  })

  it("rejects a callback state that resolves outside the configured app", () => {
    process.env.NODE_ENV = "production"
    process.env.NEXT_PUBLIC_ADMIN_URL = "https://admin.example.com"

    expect(() => buildUrl("PLATFORM", "/\\attacker.example/path")).toThrow(
      "OAuth return URL is not allowed",
    )
  })
})
