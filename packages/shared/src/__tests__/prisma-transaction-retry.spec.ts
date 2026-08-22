import {
  isPrismaUniqueConstraintError,
  isRetryablePrismaTransactionError,
  prismaTransactionRetryDelayMs,
  trustedPrismaErrorCodes,
} from "../prisma-transaction-retry"

describe("Prisma transaction error classification", () => {
  it("recognizes Prisma 7 driver-adapter serialization failures", () => {
    const error = {
      code: "P2010",
      meta: {
        driverAdapterError: {
          cause: {
            kind: "TransactionWriteConflict",
            originalCode: "40001",
          },
        },
      },
    }

    expect([...trustedPrismaErrorCodes(error)]).toEqual(["P2010", "40001"])
    expect(isRetryablePrismaTransactionError(error)).toBe(true)
  })

  it("recognizes direct Prisma DriverAdapterError transaction failures", () => {
    const error = {
      name: "DriverAdapterError",
      cause: {
        kind: "TransactionWriteConflict",
        originalCode: "40001",
      },
    }

    expect([...trustedPrismaErrorCodes(error)]).toEqual(["40001"])
    expect(isRetryablePrismaTransactionError(error)).toBe(true)
  })

  it("does not trust originalCode on an arbitrary nested cause", () => {
    const error = {
      name: "Error",
      cause: {
        originalCode: "40001",
      },
    }

    expect([...trustedPrismaErrorCodes(error)]).toEqual([])
    expect(isRetryablePrismaTransactionError(error)).toBe(false)
  })

  it.each([
    "P2034",
    "40001",
    "40P01",
  ])("recognizes structured retry code %s", (code) => {
    expect(isRetryablePrismaTransactionError({ code })).toBe(true)
  })

  it("does not infer retryability from free-form messages", () => {
    expect(
      isRetryablePrismaTransactionError({
        code: "P2010",
        message: "query failed with 40001 serialization failure",
        meta: {
          driverAdapterError: {
            cause: { message: "originalCode=40001" },
          },
        },
      }),
    ).toBe(false)
  })

  it("recognizes structured unique violations without conflating P2010", () => {
    expect(isPrismaUniqueConstraintError({ code: "P2002" })).toBe(true)
    expect(
      isPrismaUniqueConstraintError({
        code: "P2010",
        meta: {
          driverAdapterError: { cause: { originalCode: "23505" } },
        },
      }),
    ).toBe(true)
    expect(isPrismaUniqueConstraintError({ code: "P2010" })).toBe(false)
  })

  it("uses bounded equal jitter", () => {
    expect(prismaTransactionRetryDelayMs(1, () => 0)).toBe(10)
    expect(prismaTransactionRetryDelayMs(1, () => 0.999999)).toBe(20)
    expect(prismaTransactionRetryDelayMs(20, () => 0)).toBe(250)
    expect(prismaTransactionRetryDelayMs(20, () => 0.999999)).toBe(500)
  })
})
