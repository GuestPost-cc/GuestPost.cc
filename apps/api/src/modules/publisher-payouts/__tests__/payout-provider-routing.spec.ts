import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  ServiceUnavailableException,
} from "@nestjs/common"
import { PayoutExecutionService } from "../payout-execution.service"

describe("PayoutExecutionService provider routing", () => {
  const originalFinanceRuntimeMode = process.env.FINANCE_RUNTIME_MODE
  const originalLegacyMethodsEnabled = process.env.PAYOUT_LEGACY_METHODS_ENABLED
  const originalPayoutExecutionEnabled = process.env.PAYOUT_EXECUTION_ENABLED

  afterEach(() => {
    if (originalFinanceRuntimeMode === undefined) {
      delete process.env.FINANCE_RUNTIME_MODE
    } else {
      process.env.FINANCE_RUNTIME_MODE = originalFinanceRuntimeMode
    }
    if (originalLegacyMethodsEnabled === undefined) {
      delete process.env.PAYOUT_LEGACY_METHODS_ENABLED
    } else {
      process.env.PAYOUT_LEGACY_METHODS_ENABLED = originalLegacyMethodsEnabled
    }
    if (originalPayoutExecutionEnabled === undefined) {
      delete process.env.PAYOUT_EXECUTION_ENABLED
    } else {
      process.env.PAYOUT_EXECUTION_ENABLED = originalPayoutExecutionEnabled
    }
  })

  function setup(method: string) {
    const prisma = {
      withdrawal: {
        findUnique: jest.fn().mockResolvedValue({
          id: "wd-1",
          status: "APPROVED",
          method,
          currency: "USD",
          payoutMethod: {
            id: "pm-1",
            publisherId: "pub-1",
            type: method,
            isActive: true,
          },
          publisherId: "pub-1",
          publisher: { organizationId: "org-1" },
        }),
      },
      payoutExecution: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    }
    const providerService = {
      getAdapter: jest.fn(),
      getActiveProvider: jest.fn(),
    }
    const service = new PayoutExecutionService(
      prisma as any,
      { log: jest.fn() } as any,
      { decrypt: jest.fn() } as any,
      providerService as any,
    )
    return { service, providerService, prisma }
  }

  it.each([
    ["bank_transfer", "wise", "manual"],
    ["wise", "manual", "wise"],
    ["stripe_connect", "manual", "stripe_connect"],
  ])("%s rejects client-selected %s because the server derives %s", async (method, requestedProvider, _derivedProvider) => {
    const { service, providerService } = setup(method)

    await expect(
      service.executeWithdrawal(
        "wd-1",
        requestedProvider,
        "staff-1",
        "Reviewed payout routing before send",
      ),
    ).rejects.toThrow(BadRequestException)
    expect(providerService.getAdapter).not.toHaveBeenCalled()
  })

  it("fails before provider lookup when no certified adapter exists", async () => {
    const { service, providerService } = setup("paypal")

    await expect(
      service.executeWithdrawal(
        "wd-1",
        "manual",
        "staff-1",
        "Reviewed manual payout before send",
      ),
    ).rejects.toThrow(/no payout provider/i)
    expect(providerService.getAdapter).not.toHaveBeenCalled()
  })

  it("rejects a non-canonical withdrawal currency before provider routing", async () => {
    const { service, providerService, prisma } = setup("stripe_connect")
    prisma.withdrawal.findUnique.mockResolvedValue({
      id: "wd-1",
      method: "stripe_connect",
      currency: "usd",
      publicReference: "GP-WD-0001",
      publisher: { organizationId: "org-1" },
    })

    await expect(
      service.executeWithdrawal(
        "wd-1",
        "stripe_connect",
        "staff-1",
        "Reviewed corrupt payout currency before send",
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "PAYOUT_CURRENCY_INVALID" }),
    })
    expect(providerService.getAdapter).not.toHaveBeenCalled()
  })

  it("never treats the legacy-method flag as Wise provider certification", async () => {
    process.env.PAYOUT_LEGACY_METHODS_ENABLED = "true"
    process.env.PAYOUT_EXECUTION_ENABLED = "true"
    const { service, providerService } = setup("wise")

    let rejection: unknown
    try {
      await service.executeWithdrawal(
        "wd-1",
        "wise",
        "staff-1",
        "Reviewed Wise payout routing before send",
      )
    } catch (error) {
      rejection = error
    }

    expect(rejection).toBeInstanceOf(ConflictException)
    expect((rejection as ConflictException).getResponse()).toMatchObject({
      code: "PAYOUT_PROVIDER_NOT_CERTIFIED",
    })
    expect(providerService.getAdapter).not.toHaveBeenCalled()
  })

  it("blocks a new external send while Finance is in recovery-only mode", async () => {
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    const { service, prisma, providerService } = setup("stripe_connect")

    await expect(
      service.executeWithdrawal(
        "wd-1",
        "stripe_connect",
        "staff-1",
        "Reviewed Stripe payout before send",
      ),
    ).rejects.toThrow(ServiceUnavailableException)
    expect(prisma.withdrawal.findUnique).not.toHaveBeenCalled()
    expect(providerService.getAdapter).not.toHaveBeenCalled()
  })

  it("rejects a missing or unbounded operator rationale before reading payout state", async () => {
    const { service, prisma, providerService } = setup("stripe_connect")

    await expect(
      service.executeWithdrawal("wd-1", "stripe_connect", "staff-1", "short"),
    ).rejects.toThrow(BadRequestException)
    await expect(
      service.retryExecution("exec-1", "staff-1", "x".repeat(501)),
    ).rejects.toThrow(BadRequestException)
    await expect(
      service.cancelExecution("exec-1", "staff-1", ""),
    ).rejects.toThrow(BadRequestException)
    expect(prisma.withdrawal.findUnique).not.toHaveBeenCalled()
    expect(prisma.payoutExecution.findUnique).not.toHaveBeenCalled()
    expect(providerService.getAdapter).not.toHaveBeenCalled()
  })

  it("keeps exact recovery entrypoints available in recovery-only mode", async () => {
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    const { service, prisma } = setup("stripe_connect")

    await expect(
      service.retryExecution(
        "exec-1",
        "staff-1",
        "Reviewed provider recovery evidence",
      ),
    ).rejects.toThrow(NotFoundException)
    expect(prisma.payoutExecution.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "exec-1" } }),
    )
  })
})
