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
    process.env.STRIPE_SECRET_KEY = "sk_test_key"
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "some_new_status", livemode: false }),
    }) as any

    const result = await checkStripeTransferStatus("po_1", "acct_1")
    expect(result?.status).toBe("PROCESSING")
  })

  it("refuses live Stripe polling unless the independent live-money gate is enabled", async () => {
    process.env.STRIPE_SECRET_KEY = "sk_live_key"
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
})
