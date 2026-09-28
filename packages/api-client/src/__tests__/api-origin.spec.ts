import { apiV1Url, resolveApiOrigin, resolveApiV1Url } from "../api-origin"

describe("browser API origin resolution", () => {
  it.each([
    ["localhost", "http://localhost:4000"],
    ["127.0.0.1", "http://localhost:4000"],
    ["::1", "http://localhost:4000"],
    ["[::1]", "http://localhost:4000"],
  ])("permits the loopback development fallback for %s", (hostname, expected) => {
    expect(
      resolveApiOrigin({
        browserLocation: { hostname, protocol: "http:" },
        nodeEnv: "development",
      }),
    ).toBe(expected)
  })

  it("normalizes one API version suffix", () => {
    expect(
      resolveApiV1Url({ configuredUrl: "https://api.example.com/api/v1/" }),
    ).toBe("https://api.example.com/api/v1")
    expect(apiV1Url("https://api.example.com")).toBe(
      "https://api.example.com/api/v1",
    )
  })

  it.each([
    ["shohan.iam.bd", "https://api.shohan.iam.bd"],
    ["app.shohan.iam.bd", "https://api.shohan.iam.bd"],
    ["admin.guestpost.pro.bd", "https://api.guestpost.pro.bd"],
    ["publisher.client-example.net", "https://api.client-example.net"],
    ["customer-example.org", "https://api.customer-example.org"],
    ["api.customer-example.org", "https://api.customer-example.org"],
    ["app.com", "https://api.app.com"],
    ["WWW.Customer-Example.ORG.", "https://api.customer-example.org"],
  ])("selects the API sibling for %s even when a build URL is set", (hostname, expected) => {
    expect(
      resolveApiOrigin({
        configuredUrl: "https://api.guestpost.pro.bd",
        browserLocation: { hostname, protocol: "https:" },
        nodeEnv: "production",
      }),
    ).toBe(expected)
  })

  it("retains the configured API URL for other hosts", () => {
    expect(
      resolveApiOrigin({
        configuredUrl: "https://api.example.com",
        browserLocation: { hostname: "app.example.com", protocol: "https:" },
      }),
    ).toBe("https://api.example.com")
  })

  it.each(["not-a-host", "customer.example.org:443", "203.0.113.10"])(
    "uses the configured URL for a non-DNS or ambiguous host: %s",
    (hostname) => {
      expect(
        resolveApiOrigin({
          configuredUrl: "https://api.configured.example",
          browserLocation: { hostname, protocol: "https:" },
        }),
      ).toBe("https://api.configured.example")
    },
  )

  it.each([
    "http://api.example.com",
    "ftp://api.example.com",
    "https://user:secret@api.example.com",
    "https://api.example.com/path",
    "not a URL",
  ])("rejects an unsafe or malformed configured URL: %s", (configuredUrl) => {
    expect(() => resolveApiOrigin({ configuredUrl })).toThrow()
  })

  it("requires an explicit URL for production and non-loopback hosts", () => {
    expect(() => resolveApiOrigin({ nodeEnv: "production" })).toThrow(
      /required in production/,
    )
    expect(() =>
      resolveApiOrigin({
        browserLocation: {
          hostname: "admin.example.com",
          protocol: "https:",
        },
        nodeEnv: "development",
      }),
    ).toThrow(/required for a non-loopback/)
    expect(() =>
      resolveApiOrigin({
        browserLocation: { hostname: "localhost", protocol: "https:" },
        nodeEnv: "development",
      }),
    ).toThrow(/required for an HTTPS browser origin/)
  })

  it("accepts explicit HTTP only for normalized loopback authorities", () => {
    expect(
      resolveApiOrigin({ configuredUrl: "http://[::1]:4000/api/v1" }),
    ).toBe("http://[::1]:4000")
  })
})
