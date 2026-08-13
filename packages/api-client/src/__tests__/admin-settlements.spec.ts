import { AdminService } from "../services/admin"

describe("AdminService settlement eligibility", () => {
  it("uses the typed expanded-row eligibility endpoint", async () => {
    const client = {
      get: jest.fn().mockResolvedValue({ eligible: true, blockers: [] }),
    }
    const service = new AdminService(client as any)

    await service.getSettlementEligibility("settlement-1")

    expect(client.get).toHaveBeenCalledWith(
      "/admin/settlements/settlement-1/eligibility",
    )
  })
})
