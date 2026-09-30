import { ServiceUnavailableException } from "@nestjs/common"
import { ReconciliationRepairService } from "../reconciliation-repair.service"

describe("ReconciliationRepairService fail-closed rollout gate", () => {
  const originalFeatureFlag =
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED
  const originalFinanceMode = process.env.FINANCE_RUNTIME_MODE

  afterEach(() => {
    if (originalFeatureFlag === undefined)
      delete process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED
    else
      process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED = originalFeatureFlag
    if (originalFinanceMode === undefined)
      delete process.env.FINANCE_RUNTIME_MODE
    else process.env.FINANCE_RUNTIME_MODE = originalFinanceMode
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
      service.propose("case-1", "finance-user-1", {}),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(prisma.reconciliationRepairProposal.create).not.toHaveBeenCalled()
  })

  it("does not allow repair mutations outside recovery-only runtime mode", async () => {
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED = "true"
    process.env.FINANCE_RUNTIME_MODE = "normal"
    const prisma = { reconciliationRepairApproval: { findFirst: jest.fn() } }
    const service = new ReconciliationRepairService(
      prisma as any,
      {} as any,
      {} as any,
    )

    await expect(
      service.approve("case-1", "proposal-1", "finance-user-2", "a".repeat(64)),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(prisma.reconciliationRepairApproval.findFirst).not.toHaveBeenCalled()
  })
})
