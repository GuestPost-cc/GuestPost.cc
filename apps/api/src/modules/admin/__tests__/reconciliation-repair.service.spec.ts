import { ConflictException, ServiceUnavailableException } from "@nestjs/common"
import { ReconciliationRepairService } from "../reconciliation-repair.service"

describe("ReconciliationRepairService fail-closed rollout gate", () => {
  const originalFeatureFlag =
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED
  const originalFinanceMode = process.env.FINANCE_RUNTIME_MODE
  const originalDeploymentEnvironment = process.env.DEPLOYMENT_ENVIRONMENT
  const originalMfaBypass =
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS
  const originalMakerCheckerBypass =
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MAKER_CHECKER_BYPASS

  afterEach(() => {
    if (originalFeatureFlag === undefined)
      delete process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED
    else
      process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED = originalFeatureFlag
    if (originalFinanceMode === undefined)
      delete process.env.FINANCE_RUNTIME_MODE
    else process.env.FINANCE_RUNTIME_MODE = originalFinanceMode
    if (originalDeploymentEnvironment === undefined)
      delete process.env.DEPLOYMENT_ENVIRONMENT
    else process.env.DEPLOYMENT_ENVIRONMENT = originalDeploymentEnvironment
    if (originalMfaBypass === undefined)
      delete process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS
    else
      process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS =
        originalMfaBypass
    if (originalMakerCheckerBypass === undefined)
      delete process.env
        .FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MAKER_CHECKER_BYPASS
    else
      process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MAKER_CHECKER_BYPASS =
        originalMakerCheckerBypass
  })

  it("does not create a proposal unless the feature is explicitly enabled", async () => {
    delete process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    const prisma = { reconciliationRepairProposal: { create: jest.fn() } }
    const service = new ReconciliationRepairService(
      prisma as any,
      {} as any,
      {} as any,
    )

    await expect(
      service.propose("case-1", "finance-user-1", {
        providerRefundConfirmedAbsent: true,
        evidenceDigest: "a".repeat(64),
        expectedCaseVersion: 1,
        incidentReference: "provider-case-1",
        reason: "Confirmed internal wallet credit with no provider refund.",
      }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(prisma.reconciliationRepairProposal.create).not.toHaveBeenCalled()
  })

  it("does not allow repair mutations outside recovery-only runtime mode", async () => {
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED = "true"
    process.env.FINANCE_RUNTIME_MODE = "normal"
    const prisma = { $transaction: jest.fn() }
    const service = new ReconciliationRepairService(
      prisma as any,
      {} as any,
      {} as any,
    )

    await expect(
      service.approve("case-1", "proposal-1", "finance-user-2", "a".repeat(64)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("requires the database capability when the approver also executes", async () => {
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED = "true"
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    process.env.DEPLOYMENT_ENVIRONMENT = "staging"
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS = "true"
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MAKER_CHECKER_BYPASS =
      "true"
    const userId = "finance-user-2"
    const proposalDigest = "a".repeat(64)
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ enabled: false }]),
      reconciliationRepairExecution: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      reconciliationRepairProposal: {
        findFirst: jest.fn().mockResolvedValue({
          proposalDigest,
          expiresAt: new Date(Date.now() + 60_000),
        }),
      },
      reconciliationRepairApproval: {
        findUnique: jest.fn().mockResolvedValue({
          approvedByUserId: userId,
          proposalDigest,
        }),
      },
      $transaction: jest.fn(),
    }
    const service = new ReconciliationRepairService(
      prisma as any,
      {} as any,
      {} as any,
    )

    await expect(
      service.execute("case-1", "proposal-1", userId, proposalDigest, "key-1"),
    ).rejects.toBeInstanceOf(ConflictException)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it("keeps the temporary MFA bypass unavailable outside staging", async () => {
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED = "true"
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    process.env.DEPLOYMENT_ENVIRONMENT = "production"
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS = "true"
    const prisma = { $transaction: jest.fn() }
    const service = new ReconciliationRepairService(
      prisma as any,
      {} as any,
      {} as any,
    )

    await expect(
      service.approve("case-1", "proposal-1", "finance-user-2", "a".repeat(64)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})
