import {
  checkProviderTransferStatus,
  checkStripeTransferStatus,
  checkWiseTransferStatus,
} from "@guestpost/shared"

const ORIGINAL_ENV = { ...process.env }

afterEach(() => {
  process.env = { ...ORIGINAL_ENV }
  jest.restoreAllMocks()
})

describe("payout-status provider checks", () => {
  it("returns null (skip, never complete) when API keys are missing", async () => {
    delete process.env.WISE_API_KEY
    delete process.env.STRIPE_SECRET_KEY
    expect(await checkWiseTransferStatus("t-1")).toBeNull()
    expect(await checkStripeTransferStatus("t-1")).toBeNull()
  })

  it("returns null for manual and unknown providers", async () => {
    expect(await checkProviderTransferStatus("manual", "t-1")).toBeNull()
    expect(
      await checkProviderTransferStatus("something-else", "t-1"),
    ).toBeNull()
  })

  it("maps Wise statuses correctly", async () => {
    process.env.WISE_API_KEY = "key"
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "completed", fee: { amount: 2.5 } }),
    }) as any

    const result = await checkWiseTransferStatus("t-1")
    expect(result).toMatchObject({ status: "COMPLETED", fee: 2.5 })
  })

  it("maps unknown provider statuses to PROCESSING, never COMPLETED", async () => {
    process.env.STRIPE_SECRET_KEY = "rk_test_key"
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "po_1",
        status: "some_new_status",
        livemode: false,
        amount: 10_000,
        currency: "usd",
        metadata: { withdrawal_reference: "GP-WD-0001" },
      }),
    }) as any

    const result = await checkStripeTransferStatus("po_1", "acct_1", {
      amountMinor: 10_000,
      currency: "USD",
      publicReference: "GP-WD-0001",
    })
    expect(result?.status).toBe("PROCESSING")
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/payouts/po_1",
      expect.objectContaining({
        headers: {
          Authorization: "Bearer rk_test_key",
          "Stripe-Account": "acct_1",
        },
        signal: expect.any(AbortSignal),
      }),
    )
  })

  it("rejects Stripe status evidence with a different amount", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_test_key"
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "po_1",
        status: "paid",
        livemode: false,
        amount: 9_999,
        currency: "usd",
        metadata: { withdrawal_reference: "GP-WD-0001" },
      }),
    }) as any

    await expect(
      checkStripeTransferStatus("po_1", "acct_1", {
        amountMinor: 10_000,
        currency: "USD",
        publicReference: "GP-WD-0001",
      }),
    ).rejects.toThrow(/does not match the immutable payout command/i)
  })

  it("refuses live Stripe polling unless the independent live-money gate is enabled", async () => {
    process.env.STRIPE_SECRET_KEY = "rk_live_key"
    delete process.env.STRIPE_LIVE_MODE_ENABLED
    global.fetch = jest.fn() as any

    await expect(checkStripeTransferStatus("po_1", "acct_1")).rejects.toThrow(
      /live mode is disabled/i,
    )
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it("throws on provider API errors instead of guessing a status", async () => {
    process.env.WISE_API_KEY = "key"
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 503 }) as any

    await expect(checkWiseTransferStatus("t-1")).rejects.toThrow(
      "Wise status check failed: 503",
    )
  })

  it("uses an abort deadline and sanitizes provider timeout details", async () => {
    process.env.WISE_API_KEY = "key"
    const timeout = Object.assign(
      new Error('timeout body contained {"account":"sensitive"}'),
      { name: "TimeoutError" },
    )
    global.fetch = jest.fn().mockRejectedValue(timeout) as any

    await expect(checkWiseTransferStatus("t-1")).rejects.toThrow(
      "Wise status check timed out",
    )
    expect(global.fetch).toHaveBeenCalledWith(
      "https://api.transferwise.com/v1/transfers/t-1",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    )
  })

  it("rejects oversized provider responses before parsing their body", async () => {
    process.env.WISE_API_KEY = "key"
    const json = jest.fn()
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) =>
          name === "content-length" ? String(65 * 1024) : "application/json",
      },
      json,
    }) as any

    await expect(checkWiseTransferStatus("t-1")).rejects.toThrow(
      /safe size limit/i,
    )
    expect(json).not.toHaveBeenCalled()
  })

  it("rejects non-JSON and malformed provider status evidence", async () => {
    process.env.WISE_API_KEY = "key"
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      headers: {
        get: (name: string) => (name === "content-type" ? "text/html" : null),
      },
      text: async () => "<html>upstream error</html>",
    }) as any
    await expect(checkWiseTransferStatus("t-1")).rejects.toThrow(/not JSON/i)

    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: 42 }),
    }) as any
    await expect(checkWiseTransferStatus("t-1")).rejects.toThrow(
      /invalid schema/i,
    )
  })
})
