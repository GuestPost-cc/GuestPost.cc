import { GoogleAuthProvider } from "../google-auth.provider"

describe("GoogleAuthProvider account selection", () => {
  const originalClientId = process.env.GOOGLE_CLIENT_ID
  const originalClientSecret = process.env.GOOGLE_CLIENT_SECRET

  beforeEach(() => {
    process.env.GOOGLE_CLIENT_ID = "client-id"
    process.env.GOOGLE_CLIENT_SECRET = "client-secret"
  })

  afterAll(() => {
    process.env.GOOGLE_CLIENT_ID = originalClientId
    process.env.GOOGLE_CLIENT_SECRET = originalClientSecret
  })

  it("always asks the actor to select the Google data-owning account", async () => {
    const provider = new GoogleAuthProvider([
      "https://www.googleapis.com/auth/webmasters.readonly",
      "https://www.googleapis.com/auth/analytics.readonly",
    ])

    const authorizationUrl = await provider.getAuthorizationUrl(
      "state-token",
      "https://api.example.com/callback",
    )
    const params = new URL(authorizationUrl).searchParams

    expect(params.get("prompt")).toBe("select_account consent")
    expect(params.get("scope")).toContain("webmasters.readonly")
    expect(params.get("scope")).toContain("analytics.readonly")
  })
})
