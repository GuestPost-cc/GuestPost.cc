import { finalizePayoutExecution } from "../payout-finalization-core"

describe("payout webhook completion lease fencing", () => {
  it.each([
    ["a different reference", "WD-OTHER"],
    ["a missing canonical reference", "WD-EXPECTED"],
  ])("rejects manual completion under the locked withdrawal for %s", async (label, submittedReference) => {
    const auditLog = { create: jest.fn().mockResolvedValue({}) }
    const payoutExecution = {
      findUnique: jest.fn().mockResolvedValue({
        id: "execution-1",
        withdrawalId: "withdrawal-1",
        provider: { id: "manual-1", name: "manual" },
        withdrawal: {
          id: "withdrawal-1",
          publicReference:
            label === "a missing canonical reference" ? null : "WD-EXPECTED",
          publisher: { organizationId: "organization-1" },
        },
      }),
      updateMany: jest.fn(),
    }
    const withdrawal = { updateMany: jest.fn() }
    const publisherBalance = { update: jest.fn() }
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "locked" }]),
      payoutExecution,
      withdrawal,
      publisherBalance,
      auditLog,
    }
    const prisma: any = {
      $transaction: jest.fn(async (work: (client: any) => unknown) => work(tx)),
    }

    await expect(
      finalizePayoutExecution(prisma, {
        executionId: "execution-1",
        withdrawalId: "withdrawal-1",
        withdrawalPublicReference: submittedReference,
        providerName: "manual",
        providerReference: "BANK-TRACE-123",
        source: "MANUAL_BANK_CONFIRMATION",
        evidenceAt: new Date("2026-07-29T12:00:00.000Z"),
        actorUserId: "finance-checker-1",
        reason: "Verified against immutable bank evidence",
      }),
    ).resolves.toMatchObject({
      kind: "conflict",
      applied: false,
      code: "WITHDRAWAL_REFERENCE_MISMATCH",
    })

    expect(auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "PAYOUT_COMPLETION_EVIDENCE_CONFLICT",
          metadata: expect.objectContaining({
            code: "WITHDRAWAL_REFERENCE_MISMATCH",
          }),
        }),
      }),
    )
    expect(payoutExecution.updateMany).not.toHaveBeenCalled()
    expect(withdrawal.updateMany).not.toHaveBeenCalled()
    expect(publisherBalance.update).not.toHaveBeenCalled()
  })

  it("rejects stale attempt A before locking or mutating financial rows owned by recovered attempt B", async () => {
    const staleLockedAt = new Date("2026-07-29T12:00:00.000Z")
    const recoveredLockedAt = new Date("2026-07-29T12:20:00.000Z")
    const queries: Array<{ sql: string; value: string }> = []
    const payoutExecution = {
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    }
    const withdrawal = {
      updateMany: jest.fn(),
    }
    const publisherBalance = {
      findUnique: jest.fn(),
      update: jest.fn(),
    }
    const payoutWebhookEvent = {
      findUnique: jest.fn().mockResolvedValue({
        status: "PROCESSING",
        attempts: 2,
        lockedAt: recoveredLockedAt,
      }),
      updateMany: jest.fn(),
    }
    const tx: any = {
      $queryRawUnsafe: jest.fn(async (sql: string, value: string) => {
        queries.push({ sql, value })
        return [{ id: value }]
      }),
      payoutWebhookEvent,
      payoutExecution,
      withdrawal,
      publisherBalance,
    }
    const prisma: any = {
      $transaction: jest.fn(async (work: (client: any) => unknown) => work(tx)),
    }

    await expect(
      finalizePayoutExecution(prisma, {
        executionId: "execution-1",
        withdrawalId: "withdrawal-1",
        providerName: "stripe_connect",
        providerReference: "po_1",
        source: "PROVIDER_WEBHOOK",
        webhookEventId: "event-1",
        webhookClaimAttempt: 1,
        webhookClaimLockedAt: staleLockedAt,
      }),
    ).resolves.toEqual({
      kind: "conflict",
      executionId: "execution-1",
      withdrawalId: "withdrawal-1",
      applied: false,
      code: "WEBHOOK_LEASE_LOST",
      message:
        "Payout webhook processing lease changed; the stale claimant cannot mutate financial state",
    })

    expect(queries).toEqual([
      {
        sql: 'SELECT "id" FROM "PayoutWebhookEvent" WHERE "id" = $1 FOR UPDATE',
        value: "event-1",
      },
    ])
    expect(payoutExecution.findUnique).not.toHaveBeenCalled()
    expect(payoutExecution.updateMany).not.toHaveBeenCalled()
    expect(withdrawal.updateMany).not.toHaveBeenCalled()
    expect(publisherBalance.findUnique).not.toHaveBeenCalled()
    expect(publisherBalance.update).not.toHaveBeenCalled()
    expect(payoutWebhookEvent.updateMany).not.toHaveBeenCalled()
  })

  it("revalidates the lease before recording a uniqueness-collision audit after rollback", async () => {
    const staleLockedAt = new Date("2026-07-29T12:00:00.000Z")
    const recoveredLockedAt = new Date("2026-07-29T12:20:00.000Z")
    const payoutExecution = {
      findUnique: jest.fn(),
    }
    const payoutWebhookEvent = {
      findUnique: jest.fn().mockResolvedValue({
        status: "PROCESSING",
        attempts: 2,
        lockedAt: recoveredLockedAt,
      }),
      updateMany: jest.fn(),
    }
    const auditLog = { create: jest.fn() }
    const tx: any = {
      $queryRawUnsafe: jest.fn().mockResolvedValue([{ id: "event-1" }]),
      payoutWebhookEvent,
      payoutExecution,
      auditLog,
    }
    let transactionCall = 0
    const prisma: any = {
      $transaction: jest.fn(async (work: (client: any) => unknown) => {
        transactionCall += 1
        if (transactionCall === 1) {
          throw Object.assign(new Error("duplicate"), { code: "P2002" })
        }
        return work(tx)
      }),
    }

    await expect(
      finalizePayoutExecution(prisma, {
        executionId: "execution-1",
        withdrawalId: "withdrawal-1",
        providerName: "stripe_connect",
        providerReference: "po_1",
        source: "PROVIDER_WEBHOOK",
        webhookEventId: "event-1",
        webhookClaimAttempt: 1,
        webhookClaimLockedAt: staleLockedAt,
      }),
    ).resolves.toMatchObject({
      kind: "conflict",
      code: "EVIDENCE_ALREADY_USED",
      applied: false,
    })

    expect(transactionCall).toBe(2)
    expect(payoutExecution.findUnique).not.toHaveBeenCalled()
    expect(payoutWebhookEvent.updateMany).not.toHaveBeenCalled()
    expect(auditLog.create).not.toHaveBeenCalled()
  })
})
