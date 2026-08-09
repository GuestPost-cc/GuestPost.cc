import { AdminService } from "../services/admin"

describe("AdminService payout completion", () => {
  it("uses the evidence-bound manual completion route", async () => {
    const client = {
      post: jest.fn().mockResolvedValue({ status: "COMPLETED" }),
    }
    const service = new AdminService(client as any)
    const evidence = {
      withdrawalPublicReference: "GP-WD-ABCD2345",
      executionId: "exec-1",
      bankReference: "BANK-TRACE-123",
      paidAt: "2026-07-29T08:00:00.000Z",
      reason: "Verified against the bank transfer receipt",
    }

    await service.completeManualWithdrawal("wd-1", evidence)

    expect(client.post).toHaveBeenCalledWith(
      "/publisher-payouts/withdrawals/wd-1/manual-complete",
      { json: evidence },
    )
  })

  it("uses the explicit approved-withdrawal safe-abandon route", async () => {
    const client = {
      patch: jest.fn().mockResolvedValue({ status: "REJECTED" }),
    }
    const service = new AdminService(client as any)
    const reason =
      "Finance verified that every execution stopped before provider send"

    await service.abandonApprovedWithdrawal("wd-1", reason)

    expect(client.patch).toHaveBeenCalledWith(
      "/admin/withdrawals/wd-1/abandon",
      { json: { reason } },
    )
  })

  it("sends a Finance reason with every external payout command", async () => {
    const client = {
      post: jest.fn().mockResolvedValue({ status: "PROCESSING" }),
    }
    const service = new AdminService(client as any)
    const reason =
      "Finance verified the destination and exact provider evidence"

    await service.executePayout("wd-1", "stripe_connect", reason)
    await service.retryPayoutExecution("exec-1", reason)
    await service.cancelPayoutExecution("exec-2", reason)

    expect(client.post).toHaveBeenNthCalledWith(
      1,
      "/admin/withdrawals/wd-1/execute",
      { json: { providerName: "stripe_connect", reason } },
    )
    expect(client.post).toHaveBeenNthCalledWith(
      2,
      "/admin/payout-executions/exec-1/retry",
      { json: { reason } },
    )
    expect(client.post).toHaveBeenNthCalledWith(
      3,
      "/admin/payout-executions/exec-2/cancel",
      { json: { reason } },
    )
  })

  it("does not expose the retired generic Mark Paid client method", () => {
    const service = new AdminService({} as any) as unknown as Record<
      string,
      unknown
    >
    expect(service.markWithdrawalPaid).toBeUndefined()
  })
})
