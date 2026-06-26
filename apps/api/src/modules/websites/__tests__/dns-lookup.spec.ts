/**
 * Node DNS TXT lookup (checkDnsTxtToken) — verifies exact-match logic, chunked
 * TXT joining, root/www fallback, wrong-token rejection, and timeout handling.
 * node `dns` is mocked so the suite never makes a real network call.
 */
import { promises as dns } from "node:dns"
import { checkDnsTxtToken } from "@guestpost/shared/dist/dns-lookup"

jest.mock("node:dns", () => ({ promises: { resolveTxt: jest.fn() } }))
const resolveTxt = dns.resolveTxt as unknown as jest.Mock

describe("checkDnsTxtToken", () => {
  beforeEach(() => resolveTxt.mockReset())

  it("matches an exact TXT value on the root domain", async () => {
    resolveTxt.mockResolvedValueOnce([["guestpost-verification=tok"]])
    const r = await checkDnsTxtToken("https://example.com", "tok")
    expect(r).toEqual({ found: true, matchedHost: "example.com", reason: null })
  })

  it("joins multi-chunk TXT records before comparing", async () => {
    resolveTxt.mockResolvedValueOnce([["guestpost-verification=", "tok"]])
    const r = await checkDnsTxtToken("https://example.com", "tok")
    expect(r.found).toBe(true)
  })

  it("falls back to the www variant when the root has no record", async () => {
    resolveTxt
      .mockRejectedValueOnce(
        Object.assign(new Error("no data"), { code: "ENODATA" }),
      )
      .mockResolvedValueOnce([["guestpost-verification=tok"]])
    const r = await checkDnsTxtToken("https://example.com", "tok")
    expect(r).toEqual({
      found: true,
      matchedHost: "www.example.com",
      reason: null,
    })
  })

  it("rejects a present-but-wrong token", async () => {
    resolveTxt.mockResolvedValue([["guestpost-verification=WRONG"]])
    const r = await checkDnsTxtToken("https://example.com", "tok")
    expect(r.found).toBe(false)
    expect(r.reason).toMatch(/none match/i)
  })

  it("reports no record when both hosts return nothing", async () => {
    resolveTxt.mockRejectedValue(
      Object.assign(new Error("nxdomain"), { code: "ENOTFOUND" }),
    )
    const r = await checkDnsTxtToken("https://example.com", "tok")
    expect(r.found).toBe(false)
    expect(r.reason).toMatch(/No TXT record found/i)
  })

  it("times out instead of hanging on a slow resolver", async () => {
    resolveTxt.mockImplementation(() => new Promise(() => {})) // never resolves
    const r = await checkDnsTxtToken("https://example.com", "tok", {
      timeoutMs: 20,
    })
    expect(r.found).toBe(false)
    expect(r.reason).toMatch(/timed out/i)
  })

  it("returns invalid-url for empty input", async () => {
    const r = await checkDnsTxtToken("", "tok")
    expect(r).toEqual({
      found: false,
      matchedHost: null,
      reason: "Invalid website URL",
    })
  })
})
