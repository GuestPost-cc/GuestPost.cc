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
