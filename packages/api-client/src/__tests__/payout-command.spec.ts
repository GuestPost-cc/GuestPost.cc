import { ApiError } from "../client"
import { payoutErrorPresentation } from "../payout-command"

describe("payout command UI errors", () => {
  it("keeps only the sanitized server message and support request ID", () => {
    const error = new ApiError(
      503,
      "STRIPE_CONNECT_UNAVAILABLE",
      "Stripe payout setup could not be confirmed.",
      "request-payout-123",
    )

    expect(payoutErrorPresentation(error)).toEqual({
      message: "Stripe payout setup could not be confirmed.",
      requestId: "request-payout-123",
    })
  })

  it("uses a stable fallback for non-Error failures", () => {
    expect(
      payoutErrorPresentation(null, "Unable to verify payout setup"),
    ).toEqual({
      message: "Unable to verify payout setup",
    })
  })
})
