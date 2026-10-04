import { RLS_RAW_CLIENT } from "@guestpost/database"
import { ConflictException, ServiceUnavailableException } from "@nestjs/common"
import { ReconciliationRepairService } from "../reconciliation-repair.service"

const staffActor = (
  id: string,
  staffRole: "SUPER_ADMIN" | "FINANCE" = "FINANCE",
) => ({
  id,
  userType: "STAFF",
  staffRole,
  staffPermissions: [],
})

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
      service.propose("case-1", staffActor("finance-user-1"), {
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
      service.approve(
        "case-1",
        "proposal-1",
        staffActor("finance-user-2"),
        "a".repeat(64),
      ),
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
      service.execute(
        "case-1",
        "proposal-1",
        staffActor(userId),
        proposalDigest,
        "key-1",
      ),
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
      service.approve(
        "case-1",
        "proposal-1",
        staffActor("finance-user-2"),
        "a".repeat(64),
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })
})

describe("ReconciliationRepairService actor-pinned RLS transactions", () => {
  const originalFeatureFlag =
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED
  const originalFinanceMode = process.env.FINANCE_RUNTIME_MODE
  const originalDeploymentEnvironment = process.env.DEPLOYMENT_ENVIRONMENT
  const originalMfaBypass =
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS

  beforeEach(() => {
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED = "true"
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    process.env.DEPLOYMENT_ENVIRONMENT = "staging"
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS = "true"
  })

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
  })

  it.each([
    "SUPER_ADMIN",
    "FINANCE",
  ] as const)("installs the durable %s actor on the mutation transaction", async (role) => {
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED = "true"
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(1),
      reconciliationRepairProposal: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
    }
    const rawPrisma = {
      $transaction: jest.fn(async (operation: (client: typeof tx) => unknown) =>
        operation(tx),
      ),
    }
    const prisma = { [RLS_RAW_CLIENT]: rawPrisma }
    const service = new ReconciliationRepairService(
      prisma as any,
      {} as any,
      {} as any,
    )

    await expect(
      service.approve(
        "case-1",
        "proposal-1",
        staffActor("actor-1", role),
        "a".repeat(64),
      ),
    ).rejects.toMatchObject({ status: 404 })

    expect(rawPrisma.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    })
    const contextSql = tx.$executeRaw.mock.calls[0][0]
    expect(contextSql.values).toEqual([
      "API",
      "STAFF",
      "actor-1",
      "",
      "",
      "",
      "",
      role,
      "[]",
      "",
      "",
      "",
    ])
  })

  it("rejects non-finance actors before opening a repair transaction", async () => {
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED = "true"
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    const rawPrisma = { $transaction: jest.fn() }
    const service = new ReconciliationRepairService(
      { [RLS_RAW_CLIENT]: rawPrisma } as any,
      {} as any,
      {} as any,
    )

    await expect(
      service.approve(
        "case-1",
        "proposal-1",
        { ...staffActor("actor-1"), staffRole: "OPERATIONS" },
        "a".repeat(64),
      ),
    ).rejects.toMatchObject({ status: 403 })
    expect(rawPrisma.$transaction).not.toHaveBeenCalled()
  })
})

/** Build provider-free refund evidence with a controlled current wallet balance. */
function repairPreviewFixture(availableBalance: string) {
  const source = {
    id: "refund-1",
    type: "REFUND",
    amount: "5",
    currency: "USD",
    walletId: "wallet-1",
    provider: null,
    providerRef: null,
    reference: "force-cancel:order-1:incident-1",
    createdAt: new Date("2026-09-30T00:00:00.000Z"),
  }
  const wallet = {
    id: "wallet-1",
    organizationId: "org-1",
    currency: "USD",
    availableBalance,
    reservedBalance: "100",
    version: 4,
  }
  const caseRow = {
    id: "case-1",
    aggregateType: "Order",
    orderId: "order-1",
    status: "DETECTED",
    version: 2,
    currentFingerprint: "fingerprint",
    snapshots: [
      {
        findingCodes: [
          "REFUND_PARTIAL",
          "REFUND_PUBLISHER_COMPENSATION_INVALID",
        ],
      },
    ],
    order: {
      id: "order-1",
      organizationId: "org-1",
      status: "REFUNDED",
      paymentStatus: "REFUNDED",
      amount: "5",
      currency: "USD",
      fulfillmentChannel: "PUBLISHER",
      version: 3,
      refundResponsibility: "PLATFORM",
      transactions: [
        {
          id: "purchase-1",
          type: "PURCHASE",
          amount: "-5",
          currency: "USD",
          walletId: "wallet-1",
          provider: null,
          providerRef: null,
        },
        source,
      ],
      events: [
        {
          metadata: {
            refundTransactionId: source.id,
            responsibility: "PLATFORM",
          },
        },
      ],
      website: { publisherId: "publisher-1", ownershipType: "PUBLISHER" },
      settlements: [{ publisherId: "publisher-1", publisherAmount: "5" }],
      publisherCompensation: {
        disposition: "EXACT_AMOUNT",
        amount: "5",
        currency: "USD",
        refundTransactionId: source.id,
        responsibility: "PLATFORM",
        effectiveOrderStatus: "PUBLISHED",
        reason: "Platform cancellation after publisher delivery.",
        publisherId: "publisher-1",
        compensationTransactionId: "compensation-1",
        compensationTransaction: {
          id: "compensation-1",
          type: "PUBLISHER_COMPENSATION",
          orderId: "order-1",
          publisherId: "publisher-1",
          currency: "USD",
          amount: "5",
        },
        debtRepaymentTransactionId: null,
        debtRepaymentTransaction: null,
      },
      dispute: null,
      fraudFindings: [],
    },
  }
  const prisma = {
    reconciliationCase: {
      findUnique: jest.fn().mockResolvedValue(caseRow),
    },
    wallet: { findUnique: jest.fn().mockResolvedValue(wallet) },
    paymentDispute: { count: jest.fn().mockResolvedValue(0) },
    // Models a later wallet debit; fungible, currently available funds decide
    // whether the exact reversal is affordable.
    transaction: { count: jest.fn().mockResolvedValue(1) },
  }
  return {
    prisma,
    service: new ReconciliationRepairService(
      prisma as any,
      {} as any,
      {} as any,
    ),
  }
}

describe("ReconciliationRepairService wallet affordability", () => {
  it("allows reversal with sufficient available funds despite later spending", async () => {
    const { prisma, service } = repairPreviewFixture("5")

    const preview = await service.preview("case-1")

    expect(preview.eligible).toBe(true)
    expect(preview.blockers).not.toContain(
      "REFUND_CREDIT_MAY_BE_SPENT_OR_RESERVED",
    )
    expect(preview.balance).toMatchObject({
      availableBefore: "5",
      availableAfter: "0",
      reservedUnchanged: "100",
    })
    expect(prisma.transaction.count).not.toHaveBeenCalled()
  })

  it("blocks when available funds are short even if reserved funds exist", async () => {
    const { service } = repairPreviewFixture("4.99")

    const preview = await service.preview("case-1")

    expect(preview.eligible).toBe(false)
    expect(preview.blockers).toContain("INSUFFICIENT_AVAILABLE_FUNDS")
  })
})
