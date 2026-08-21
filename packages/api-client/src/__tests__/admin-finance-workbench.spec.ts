import { HttpClient } from "../client"
import {
  type AdminFinanceWorkbenchResponse,
  AdminService,
} from "../services/admin"

const financeWorkbench = {
  generatedAt: "2026-08-14T05:00:00.000Z",
  currency: "USD",
  overview: {
    readyForDecision: 1,
    fundsInFlight: "125.00",
    financialExceptions: 0,
    netRevenue30d: "25.00",
  },
  actionQueue: [
    {
      id: "settlement-1",
      type: "SETTLEMENT",
      priority: "HIGH",
      title: "Settlement ready",
      description: "Review settlement evidence",
      href: "/dashboard/settlements/settlement-1",
      createdAt: "2026-08-14T04:00:00.000Z",
      deadlineAt: null,
      amount: "100.00",
      currency: "USD",
    },
  ],
  pipeline: { settlements: [], withdrawals: [], payouts: [] },
  decisions: {
    settlementsReady: 1,
    withdrawalsEligible: 0,
    cancellationsPendingFinance: 0,
    activeDisputes: 0,
  },
  reconciliation: {
    available: true,
    ok: true,
    critical: 0,
    warning: 0,
    totalIssues: 0,
    ranAt: "2026-08-14T04:30:00.000Z",
  },
  revenue: {
    available: false,
    current: null,
    previous: null,
    deltaPct: null,
    currencyMismatch: null,
  },
  publisherRisk: { publishersWithDebt: 0, totalDebt: "0.00", items: [] },
  recentActivity: [],
} satisfies AdminFinanceWorkbenchResponse

describe("AdminService Finance workbench contract", () => {
  it("does not retain support actions, counts, or message metadata", async () => {
    const client = new HttpClient({
      baseUrl: "https://api.example.test/api/v1",
    })
    const service = new AdminService(client)
    const get = jest
      .spyOn(client, "get")
      .mockResolvedValueOnce(financeWorkbench)

    const result = await service.getFinanceWorkbench()

    expect(get).toHaveBeenCalledWith("/admin/finance-workbench")
    expect(result).not.toHaveProperty("support")
    expect(result.overview).not.toHaveProperty("activeSupport")
    expect(result.actionQueue.map((item) => item.type)).not.toContain("SUPPORT")
  })
})
