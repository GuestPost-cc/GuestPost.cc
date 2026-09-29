import {
  apiV1Url,
  hostnameFromHostHeader,
  resolveApiOrigin,
  resolveApiV1Url,
  resolveInstanceOrigin,
  resolveRequestInstanceOrigin,
} from "../api-origin"

describe("browser API origin resolution", () => {
  it.each([
    ["app.shohan.iam.bd", "app.shohan.iam.bd"],
    ["app.shohan.iam.bd:443", "app.shohan.iam.bd"],
    ["APP.SHOHAN.IAM.BD:8443", "app.shohan.iam.bd"],
    ["[::1]:3000", "[::1]"],
  ])("extracts a hostname from a valid Host authority: %s", (authority, expected) => {
    expect(hostnameFromHostHeader(authority)).toBe(expected)
  })

  it.each([
    null,
    "",
    "app.shohan.iam.bd, attacker.example",
    "user@app.shohan.iam.bd",
    "app.shohan.iam.bd/path",
    "app.shohan.iam.bd:invalid",
  ])("rejects an invalid Host authority: %s", (authority) => {
    expect(hostnameFromHostHeader(authority)).toBeNull()
  })

  it("derives the matching API origin from the public Host header", () => {
    const hostname = hostnameFromHostHeader("app.shohan.iam.bd:443")
    expect(hostname).not.toBeNull()
    expect(
      resolveApiOrigin({
        configuredUrl: "https://api.guestpost.pro.bd",
        allowedAppDomains: ["shohan.iam.bd"],
        browserLocation: { hostname: hostname!, protocol: "https:" },
        nodeEnv: "production",
      }),
    ).toBe("https://api.shohan.iam.bd")
  })

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
    ["shohan.iam.bd", "https://api.shohan.iam.bd", "shohan.iam.bd"],
    ["app.shohan.iam.bd", "https://api.shohan.iam.bd", "shohan.iam.bd"],
    [
      "admin.guestpost.pro.bd",
      "https://api.guestpost.pro.bd",
      "guestpost.pro.bd",
    ],
    [
      "publisher.client-example.net",
      "https://api.client-example.net",
      "client-example.net",
    ],
    [
      "customer-example.org",
      "https://api.customer-example.org",
      "customer-example.org",
    ],
    [
      "api.customer-example.org",
      "https://api.customer-example.org",
      "customer-example.org",
    ],
    ["app.com", "https://api.app.com", "app.com"],
    [
      "WWW.Customer-Example.ORG.",
      "https://api.customer-example.org",
      "customer-example.org",
    ],
  ])("selects the API sibling for allow-listed host %s even when a build URL is set", (hostname, expected, allowedDomain) => {
    expect(
      resolveApiOrigin({
        configuredUrl: "https://api.guestpost.pro.bd",
        allowedAppDomains: [allowedDomain],
        browserLocation: { hostname, protocol: "https:" },
        nodeEnv: "production",
      }),
    ).toBe(expected)
  })

  it("retains the configured API URL for other hosts", () => {
    expect(
      resolveApiOrigin({
        configuredUrl: "https://api.guestpost.pro.bd",
        browserLocation: {
          hostname: "guestpost-portal.onrender.com",
          protocol: "https:",
        },
      }),
    ).toBe("https://api.guestpost.pro.bd")
  })

  it("accepts a comma-separated public-domain allowlist", () => {
    expect(
      resolveApiOrigin({
        configuredUrl: "https://api.guestpost.pro.bd",
        allowedAppDomains: "guestpost.pro.bd, shohan.iam.bd",
        browserLocation: {
          hostname: "app.shohan.iam.bd",
          protocol: "https:",
        },
      }),
    ).toBe("https://api.shohan.iam.bd")
  })

  it.each([
    "not-a-host",
    "customer.example.org:443",
    "203.0.113.10",
  ])("uses the configured URL for a non-DNS or ambiguous host: %s", (hostname) => {
    expect(
      resolveApiOrigin({
        configuredUrl: "https://api.configured.example",
        browserLocation: { hostname, protocol: "https:" },
      }),
    ).toBe("https://api.configured.example")
  })

  it.each([
    "http://api.example.com",
    "ftp://api.example.com",
    "https://user:secret@api.example.com",
    "https://api.example.com/path",
    "not a URL",
  ])("rejects an unsafe or malformed configured URL: %s", (configuredUrl) => {
    expect(() => resolveApiOrigin({ configuredUrl })).toThrow()
  })

  it("derives API origins for valid external hosts without an explicit URL", () => {
    expect(
      resolveApiOrigin({
        browserLocation: {
          hostname: "admin.arbitrary-example.com",
          protocol: "https:",
        },
        allowedAppDomains: ["arbitrary-example.com"],
        nodeEnv: "production",
      }),
    ).toBe("https://api.arbitrary-example.com")
  })

  it("requires an explicit URL for production and invalid non-loopback hosts", () => {
    expect(() => resolveApiOrigin({ nodeEnv: "production" })).toThrow(
      /required in production/,
    )
    expect(() =>
      resolveApiOrigin({
        browserLocation: {
          hostname: "not-a-host",
          protocol: "https:",
        },
        nodeEnv: "development",
      }),
    ).toThrow(/required for an unrecognized non-loopback/)
    expect(() =>
      resolveApiOrigin({
        browserLocation: {
          hostname: "attacker.example",
          protocol: "https:",
        },
        nodeEnv: "production",
      }),
    ).toThrow(/required for an unrecognized non-loopback/)
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

describe("allow-listed instance app origin resolution", () => {
  it.each([
    ["website", "shohan.iam.bd", "https://shohan.iam.bd"],
    ["portal", "shohan.iam.bd", "https://app.shohan.iam.bd"],
    ["publisher", "shohan.iam.bd", "https://publisher.shohan.iam.bd"],
    ["admin", "shohan.iam.bd", "https://admin.shohan.iam.bd"],
    ["portal", "admin.client-example.net", "https://app.client-example.net"],
  ] as const)("resolves %s on %s to %s", (surface, hostname, expected) => {
    expect(
      resolveInstanceOrigin(surface, {
        configuredUrl: "https://app.guestpost.pro.bd",
        allowedAppDomains: ["shohan.iam.bd", "client-example.net"],
        browserLocation: { hostname, protocol: "https:" },
        nodeEnv: "production",
      }),
    ).toBe(expected)
  })

  it("uses the configured app origin for hosts outside the allowlist", () => {
    expect(
      resolveInstanceOrigin("portal", {
        configuredUrl: "https://app.guestpost.pro.bd",
        allowedAppDomains: ["shohan.iam.bd"],
        browserLocation: {
          hostname: "preview.example.net",
          protocol: "https:",
        },
        nodeEnv: "production",
      }),
    ).toBe("https://app.guestpost.pro.bd")
  })

  it("rejects unsafe configured destinations", () => {
    expect(() =>
      resolveInstanceOrigin("portal", {
        configuredUrl: "https://attacker:secret@example.net/path",
      }),
    ).toThrow(/cannot contain credentials, a path, query, or fragment/)
  })

  it("accepts only an exact allow-listed request origin", () => {
    expect(
      resolveRequestInstanceOrigin("portal", "https://app.stage.example.com", {
        allowedAppDomains: ["stage.example.com"],
        nodeEnv: "production",
      }),
    ).toBe("https://app.stage.example.com")
    expect(
      resolveRequestInstanceOrigin("portal", "https://attacker.example.com", {
        allowedAppDomains: ["stage.example.com"],
        nodeEnv: "production",
      }),
    ).toBeNull()
  })
})
