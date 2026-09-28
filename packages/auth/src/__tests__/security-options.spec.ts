import {
  AUTH_ACCOUNT_OPTIONS,
  AUTH_SESSION_OPTIONS,
  betterAuthBaseURL,
  googleProviderOptions,
} from "../security-options"

describe("auth security options", () => {
  const originalEnv = {
    NODE_ENV: process.env.NODE_ENV,
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
    BETTER_AUTH_ALLOWED_HOSTS: process.env.BETTER_AUTH_ALLOWED_HOSTS,
  }

  afterEach(() => {
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value == null) delete process.env[key]
      else process.env[key] = value
    }
  })

  it("uses only exact configured API hosts for dynamic auth callbacks", () => {
    process.env.NODE_ENV = "production"
    process.env.BETTER_AUTH_URL = "https://api.guestpost.pro.bd"
    process.env.BETTER_AUTH_ALLOWED_HOSTS =
      " api.guestpost.pro.bd, api.shohan.iam.bd "

    expect(betterAuthBaseURL()).toEqual({
      allowedHosts: ["api.guestpost.pro.bd", "api.shohan.iam.bd"],
      protocol: "https",
    })
  })

  it("defaults dynamic auth hosts to HTTPS outside explicit local development", () => {
    process.env.NODE_ENV = "staging"
    process.env.BETTER_AUTH_ALLOWED_HOSTS = "api.example.com"

    expect(betterAuthBaseURL()).toEqual({
      allowedHosts: ["api.example.com"],
      protocol: "https",
    })

    process.env.NODE_ENV = "development"
    expect(betterAuthBaseURL()).toEqual({
      allowedHosts: ["api.example.com"],
      protocol: "http",
    })
  })

  it("rejects wildcard and URL entries in the auth host allowlist", () => {
    process.env.BETTER_AUTH_ALLOWED_HOSTS = "*.example.com"
    expect(() => betterAuthBaseURL()).toThrow(
      "BETTER_AUTH_ALLOWED_HOSTS must contain exact valid hostnames",
    )
  })

  it("rejects malformed hostnames and empty production lists", () => {
    process.env.BETTER_AUTH_ALLOWED_HOSTS = "api..example.com"
    expect(() => betterAuthBaseURL()).toThrow(
      "BETTER_AUTH_ALLOWED_HOSTS must contain exact valid hostnames",
    )
    process.env.BETTER_AUTH_ALLOWED_HOSTS = ", ,"
    expect(() => betterAuthBaseURL()).toThrow(
      "BETTER_AUTH_ALLOWED_HOSTS must not be empty",
    )
  })

  it("preserves the static local base URL when no host allowlist is set", () => {
    delete process.env.BETTER_AUTH_ALLOWED_HOSTS
    process.env.BETTER_AUTH_URL = "http://localhost:4000"
    expect(betterAuthBaseURL()).toBe("http://localhost:4000")
  })

  it("requires explicit Google signup and disables implicit account linking", () => {
    expect(googleProviderOptions()).toMatchObject({
      disableImplicitSignUp: true,
      prompt: "select_account",
    })
    expect(AUTH_ACCOUNT_OPTIONS.accountLinking.disableImplicitLinking).toBe(
      true,
    )
  })

  it("uses the bounded rolling session policy", () => {
    expect(AUTH_SESSION_OPTIONS).toMatchObject({
      expiresIn: 8 * 60 * 60,
      updateAge: 30 * 60,
      freshAge: 30 * 60,
    })
  })
})
