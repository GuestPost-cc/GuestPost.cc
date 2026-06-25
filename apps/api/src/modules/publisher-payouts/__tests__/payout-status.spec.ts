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
    process.env.STRIPE_SECRET_KEY = "key"
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ status: "some_new_status" }),
    }) as any

    const result = await checkStripeTransferStatus("t-1")
    expect(result?.status).toBe("PROCESSING")
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
