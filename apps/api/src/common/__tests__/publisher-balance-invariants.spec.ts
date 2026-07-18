import { Decimal } from "@prisma/client/runtime/client"
import {
  checkPublisherBalanceInvariant,
  PublisherBalanceInvariantError,
} from "../publisher-balance-invariants"

describe("checkPublisherBalanceInvariant", () => {
  const logger = {
    error: jest.fn(),
  } as any

  beforeEach(() => {
    jest.clearAllMocks()
  })

  it("accepts null and non-negative Decimal balances", () => {
    expect(() =>
      checkPublisherBalanceInvariant(null, logger, "test/null"),
    ).not.toThrow()
    expect(() =>
      checkPublisherBalanceInvariant(
        {
          publisherId: "publisher-1",
          withdrawableBalance: new Decimal("0.00"),
          debtBalance: new Decimal("10.25"),
        },
        logger,
        "test/valid",
      ),
    ).not.toThrow()
    expect(logger.error).not.toHaveBeenCalled()
  })

  it.each([
    {
      field: "withdrawableBalance",
      balance: { withdrawableBalance: "-0.01", debtBalance: "0" },
    },
    {
      field: "debtBalance",
      balance: { withdrawableBalance: "0", debtBalance: "-0.01" },
    },
  ])("logs and throws when $field is negative", ({ balance }) => {
    expect(() =>
      checkPublisherBalanceInvariant(
        { publisherId: "publisher-1", ...balance },
        logger,
        "test/negative",
      ),
    ).toThrow(PublisherBalanceInvariantError)
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({
        publisherId: "publisher-1",
        context: "test/negative",
      }),
      "publisher balance invariant violation",
    )
  })
})
