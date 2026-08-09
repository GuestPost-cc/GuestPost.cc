import { ServiceUnavailableException } from "@nestjs/common"
import { AllExceptionsFilter } from "./all-exceptions.filter"

function responseHarness() {
  const response = {
    status: jest.fn(),
    json: jest.fn(),
  }
  response.status.mockReturnValue(response)
  const host = {
    switchToHttp: () => ({ getResponse: () => response }),
  }
  return { response, host }
}

describe("AllExceptionsFilter safe server errors", () => {
  it("exposes only the allowlisted sanitized deposit availability message", () => {
    const { response, host } = responseHarness()
    const filter = new AllExceptionsFilter()

    filter.catch(
      new ServiceUnavailableException({
        code: "DEPOSIT_PROVIDER_UNAVAILABLE",
        message: "Secure card checkout is temporarily unavailable.",
      }),
      host as any,
    )

    expect(response.status).toHaveBeenCalledWith(503)
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 503,
      code: "DEPOSIT_PROVIDER_UNAVAILABLE",
      message: "Secure card checkout is temporarily unavailable.",
    })
  })

  it("continues to redact an unclassified server failure", () => {
    const { response, host } = responseHarness()
    const filter = new AllExceptionsFilter()

    filter.catch(new Error("provider diagnostic must not escape"), host as any)

    expect(response.status).toHaveBeenCalledWith(500)
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 500,
      message: "Internal server error",
    })
  })

  it("exposes the sanitized Stripe Connect outage without provider diagnostics", () => {
    const { response, host } = responseHarness()
    const filter = new AllExceptionsFilter()

    filter.catch(
      new ServiceUnavailableException({
        code: "STRIPE_CONNECT_UNAVAILABLE",
        message:
          "Stripe payout setup could not be confirmed. No withdrawal was submitted. Retry or refresh the provider status later.",
      }),
      host as any,
    )

    expect(response.status).toHaveBeenCalledWith(503)
    expect(response.json).toHaveBeenCalledWith({
      statusCode: 503,
      code: "STRIPE_CONNECT_UNAVAILABLE",
      message:
        "Stripe payout setup could not be confirmed. No withdrawal was submitted. Retry or refresh the provider status later.",
    })
    expect(JSON.stringify(response.json.mock.calls)).not.toContain(
      "provider diagnostic",
    )
  })

  it("exposes a safe finance pause without its internal mode or operation", () => {
    const { response, host } = responseHarness()
    const filter = new AllExceptionsFilter()

    filter.catch(
      new ServiceUnavailableException({
        code: "FINANCE_OPERATION_BLOCKED",
        message:
          "This financial action is temporarily unavailable. Retry later or contact support.",
        mode: "locked",
        operation: "external_send",
      }),
      host as any,
    )

    expect(response.json).toHaveBeenCalledWith({
      statusCode: 503,
      code: "FINANCE_OPERATION_BLOCKED",
      message:
        "This financial action is temporarily unavailable. Retry later or contact support.",
    })
    expect(JSON.stringify(response.json.mock.calls)).not.toMatch(
      /locked|external_send/,
    )
  })
})
