import { HttpClient } from "../client"

describe("HttpClient cookie-only CSRF protection", () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    jest.restoreAllMocks()
  })

  function mockResponse() {
    globalThis.fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: jest.fn().mockReturnValue(null) },
      json: jest.fn().mockResolvedValue({ ok: true }),
    }) as jest.MockedFunction<typeof fetch>
  }

  it("sends cookies and the CSRF protection header on mutations", async () => {
    mockResponse()
    const client = new HttpClient({ baseUrl: "https://api.example.com" })

    await client.post("/orders", { json: { listingId: "listing-1" } })

    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(init.credentials).toBe("include")
    expect(init.headers).toMatchObject({
      "X-CSRF-Protection": "1",
    })
    expect(init.headers).not.toHaveProperty("Authorization")
  })

  it("does not add the mutation header to safe reads", async () => {
    mockResponse()
    const client = new HttpClient({ baseUrl: "https://api.example.com" })

    await client.get("/orders")

    const [, init] = (globalThis.fetch as jest.Mock).mock.calls[0]
    expect(init.headers).not.toHaveProperty("X-CSRF-Protection")
  })
})
