import { ApiError } from "../client"
import {
  bindDepositIdempotencyKey,
  depositErrorPresentation,
} from "../deposit-command"

describe("deposit command UI safety", () => {
  it("reuses a key only for the exact wallet, amount, and currency", () => {
    const createKey = jest
      .fn()
      .mockReturnValueOnce("key-1")
      .mockReturnValueOnce("key-2")
      .mockReturnValueOnce("key-3")

    const first = bindDepositIdempotencyKey(
      null,
      { walletId: "wallet-1", amount: 25, currency: "USD" },
      createKey,
    )
    const replay = bindDepositIdempotencyKey(
      first,
      { walletId: "wallet-1", amount: 25, currency: "USD" },
      createKey,
    )
    const changedAmount = bindDepositIdempotencyKey(
      replay,
      { walletId: "wallet-1", amount: 25.01, currency: "USD" },
      createKey,
    )
    const changedWallet = bindDepositIdempotencyKey(
      changedAmount,
      { walletId: "wallet-2", amount: 25.01, currency: "USD" },
      createKey,
    )

    expect(replay).toBe(first)
    expect(changedAmount.key).toBe("key-2")
    expect(changedWallet.key).toBe("key-3")
    expect(createKey).toHaveBeenCalledTimes(3)
  })

  it("keeps the sanitized API message and support request ID", () => {
    const error = new ApiError(
      503,
      "DEPOSIT_PROVIDER_UNAVAILABLE",
      "Secure card checkout is temporarily unavailable.",
      "request-123",
    )

    expect(depositErrorPresentation(error)).toEqual({
      message: "Secure card checkout is temporarily unavailable.",
      requestId: "request-123",
    })
  })

  it("uses a safe fallback for non-Error failures", () => {
    expect(depositErrorPresentation(null)).toEqual({
      message: "Failed to initiate deposit",
    })
  })
})
