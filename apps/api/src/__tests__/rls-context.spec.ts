import {
  getRlsRequestContext,
  RLS_RAW_CLIENT,
  requireRlsRequestContext,
  runWithRlsRequestScope,
  setApplicationRlsContext,
  setRlsRequestContext,
  withApiKeyValidationRlsContext,
  withApplicationRlsContext,
} from "@guestpost/database"

type SqlValue = { strings: readonly string[]; values: readonly unknown[] }

function transactionHarness() {
  const tx = { $executeRaw: jest.fn().mockResolvedValue(1) }
  const prisma = {
    $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) =>
      operation(tx),
    ),
  }
  return { prisma, tx }
}

function configuredValues(tx: { $executeRaw: jest.Mock }): readonly unknown[] {
  const sql = tx.$executeRaw.mock.calls.at(-1)?.[0] as SqlValue
  return sql.values
}

describe("application RLS context", () => {
  it("isolates mutable request context slots between concurrent requests", async () => {
    const first = runWithRlsRequestScope(async () => {
      setRlsRequestContext({ workload: "PUBLIC" })
      await Promise.resolve()
      return getRlsRequestContext()
    })
    const second = runWithRlsRequestScope(async () => {
      setRlsRequestContext({
        workload: "WORKER",
        worker: "email_dispatch",
      })
      await Promise.resolve()
      return getRlsRequestContext()
    })

    await expect(first).resolves.toEqual({ workload: "PUBLIC" })
    await expect(second).resolves.toEqual({
      workload: "WORKER",
      worker: "email_dispatch",
    })
    expect(getRlsRequestContext()).toBeNull()
  })

  it("fails closed when database access has no request context", () => {
    expect(() => requireRlsRequestContext()).toThrow(
      "RLS context is required for database access",
    )
  })

  it("sets every context field and clears fields from a previous actor", async () => {
    const { tx } = transactionHarness()

    await setApplicationRlsContext(tx as any, {
      workload: "API",
      actorId: "staff-1",
      actorKind: "STAFF",
      staffRole: "FINANCE",
      staffPermissions: ["PAYOUT_READ", "PAYOUT_APPROVE"],
    })
    expect(configuredValues(tx)).toEqual([
      "API",
      "STAFF",
      "staff-1",
      "",
      "",
      "",
      "",
      "FINANCE",
      '["PAYOUT_READ","PAYOUT_APPROVE"]',
      "",
      "",
      "",
    ])

    await setApplicationRlsContext(tx as any, { workload: "PUBLIC" })
    expect(configuredValues(tx)).toEqual([
      "PUBLIC",
      "",
      "",
      "",
      "",
      "",
      "",
      "",
      "[]",
      "",
      "",
      "",
    ])
  })

  it("pins publisher context to the operation transaction", async () => {
    const { prisma, tx } = transactionHarness()
    const operation = jest.fn().mockResolvedValue("ok")

    await expect(
      withApplicationRlsContext(
        prisma as any,
        {
          workload: "API",
          actorId: "publisher-user-1",
          actorKind: "PUBLISHER",
          publisherId: "publisher-1",
          publisherRole: "PUBLISHER_OWNER",
        },
        operation,
      ),
    ).resolves.toBe("ok")

    expect(prisma.$transaction).toHaveBeenCalledTimes(1)
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    expect(operation).toHaveBeenCalledWith(tx)
  })

  it("rejects malformed worker and permission values before querying", async () => {
    const { tx } = transactionHarness()

    await expect(
      setApplicationRlsContext(tx as any, {
        workload: "WORKER",
        worker: "email\nSET ROLE owner",
      }),
    ).rejects.toThrow("Invalid RLS worker")

    await expect(
      setApplicationRlsContext(tx as any, {
        workload: "API",
        actorId: "staff-1",
        actorKind: "STAFF",
        staffRole: "OPERATIONS",
        staffPermissions: ["not normalized"],
      }),
    ).rejects.toThrow("Invalid RLS staff permission")

    expect(tx.$executeRaw).not.toHaveBeenCalled()
  })

  it("opaque-key auth clears every actor and workload-specific field", async () => {
    const { prisma, tx } = transactionHarness()
    const keyHash = "a".repeat(64)

    await withApiKeyValidationRlsContext(
      prisma as any,
      { keyHash },
      async () => undefined,
    )

    const sql = tx.$executeRaw.mock.calls[0][0] as SqlValue
    expect(sql.strings.join(" ")).toContain("guestpost.rls_publisher_id")
    expect(sql.strings.join(" ")).toContain("guestpost.rls_staff_role")
    expect(sql.strings.join(" ")).toContain("guestpost.rls_resource_id")
    expect(sql.values).toEqual([keyHash])
  })

  it("uses the raw host for explicit security contexts", async () => {
    const { prisma: raw, tx } = transactionHarness()
    const wrappedTransaction = jest.fn(() => {
      throw new Error(
        "general request proxy must not intercept explicit context",
      )
    })
    const wrapped = {
      $transaction: wrappedTransaction,
      [RLS_RAW_CLIENT]: raw,
    }

    await withApiKeyValidationRlsContext(
      wrapped as any,
      { keyHash: "b".repeat(64) },
      async () => undefined,
    )

    expect(raw.$transaction).toHaveBeenCalledTimes(1)
    expect(wrappedTransaction).not.toHaveBeenCalled()
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
  })
})
