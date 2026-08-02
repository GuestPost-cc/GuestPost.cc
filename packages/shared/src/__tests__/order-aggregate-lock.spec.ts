import {
  lockOrderAggregate,
  runLockedOrderSerializableTransaction,
} from "../order-aggregate-lock"

describe("Order aggregate locking", () => {
  it("locks Order before any settlement-blocking child write", async () => {
    const calls: string[] = []
    const tx = {
      $queryRaw: jest.fn(async () => {
        calls.push("order-lock")
        return [{ id: "order-1" }]
      }),
      orderDispute: {
        updateMany: jest.fn(async () => {
          calls.push("child-write")
          return { count: 1 }
        }),
      },
    }
    const prisma = {
      $transaction: jest.fn(async (operation: (db: any) => Promise<any>) =>
        operation(tx),
      ),
    }

    await runLockedOrderSerializableTransaction(prisma, "order-1", async (db) =>
      db.orderDispute.updateMany({ where: { id: "dispute-1" } }),
    )

    expect(calls).toEqual(["order-lock", "child-write"])
    expect(prisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    })
  })

  it("restarts the complete lock-first closure after a trusted deadlock", async () => {
    const calls: string[] = []
    const tx = {
      $queryRaw: jest.fn(async () => {
        calls.push("order-lock")
        return [{ id: "order-1" }]
      }),
    }
    let attempt = 0
    const prisma = {
      $transaction: jest.fn(async (operation: (db: any) => Promise<string>) => {
        attempt++
        const result = await operation(tx)
        if (attempt === 1) throw { code: "P2034" }
        return result
      }),
    }

    const result = await runLockedOrderSerializableTransaction(
      prisma,
      "order-1",
      async () => {
        calls.push("db-work")
        return "committed"
      },
    )

    expect(result).toBe("committed")
    expect(prisma.$transaction).toHaveBeenCalledTimes(2)
    expect(calls).toEqual(["order-lock", "db-work", "order-lock", "db-work"])
  })

  it("does not retry domain or constraint failures", async () => {
    const domainError = Object.assign(new Error("not allowed"), {
      code: "P2002",
    })
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) }
    const prisma = {
      $transaction: jest.fn(async (operation: (db: any) => Promise<any>) =>
        operation(tx),
      ),
    }

    await expect(
      runLockedOrderSerializableTransaction(prisma, "order-1", async () => {
        throw domainError
      }),
    ).rejects.toBe(domainError)
    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
  })

  it("binds the order id instead of concatenating it into SQL", async () => {
    const query = jest.fn().mockResolvedValue([])

    await lockOrderAggregate({ $queryRaw: query }, "order-'unsafe")

    const [strings, value] = query.mock.calls[0]
    expect(strings.join("?")).toBe(
      'SELECT "id" FROM "Order" WHERE "id" = ? FOR UPDATE',
    )
    expect(value).toBe("order-'unsafe")
  })
})
