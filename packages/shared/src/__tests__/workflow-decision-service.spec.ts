import { WorkflowDecisionService } from "../workflow/decision-service"
import { loadWorkflowConfig } from "../workflow/workflow-config"

const cleanHistory = { chargebackCount: 0, disputeCount: 0 }

function service(enableAutoRelease = true) {
  return new WorkflowDecisionService(
    loadWorkflowConfig({ enableAutoRelease, autoReleaseMaxAmount: 100_000 }),
  )
}

describe("WorkflowDecisionService settlement release policy", () => {
  it.each([
    "NEW",
    "unknown",
    undefined,
  ])("requires manual review for an untrusted publisher tier (%s) even when auto-release is enabled", (tier) => {
    expect(
      service().computeSettlementReleasePolicy(
        { verifyMethod: "AUTO", amount: 100 },
        tier === undefined ? null : { tier },
        [],
        cleanHistory,
      ),
    ).toBe("MANUAL")
  })

  it("requires manual review above, but not exactly at, the configured amount ceiling", () => {
    const decision = service()

    expect(
      decision.computeSettlementReleasePolicy(
        { verifyMethod: "AUTO", amount: 100_000.01 },
        { tier: "VERIFIED" },
        [],
        cleanHistory,
      ),
    ).toBe("MANUAL")
    expect(
      decision.computeSettlementReleasePolicy(
        { verifyMethod: "AUTO", amount: 100_000 },
        { tier: "VERIFIED" },
        [],
        cleanHistory,
      ),
    ).toBe("AUTO")
  })

  it("requires manual review for any durable chargeback history", () => {
    expect(
      service().computeSettlementReleasePolicy(
        { verifyMethod: "AUTO", amount: 100 },
        { tier: "TRUSTED" },
        [],
        { chargebackCount: 1, disputeCount: 0 },
      ),
    ).toBe("MANUAL")
  })

  it.each([
    ["missing history", null],
    ["negative history", { chargebackCount: -1, disputeCount: 0 }],
    ["fractional history", { chargebackCount: 0.5, disputeCount: 0 }],
    ["invalid dispute history", { chargebackCount: 0, disputeCount: -1 }],
  ])("fails closed for %s", (_label, history) => {
    expect(
      service().computeSettlementReleasePolicy(
        { verifyMethod: "AUTO", amount: 100 },
        { tier: "TRUSTED" },
        [],
        history,
      ),
    ).toBe("MANUAL")
  })

  it.each([
    undefined,
    null,
    0,
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])("fails closed for an invalid amount (%s)", (amount) => {
    expect(
      service().computeSettlementReleasePolicy(
        { verifyMethod: "AUTO", amount },
        { tier: "TRUSTED" },
        [],
        cleanHistory,
      ),
    ).toBe("MANUAL")
  })

  it("keeps the operational kill switch separate from risk classification", () => {
    const disabled = service(false)

    expect(
      disabled.computeSettlementReleasePolicy(
        { verifyMethod: "AUTO", amount: 100 },
        { tier: "TRUSTED" },
        [],
        cleanHistory,
      ),
    ).toBe("AUTO")
    expect(
      disabled.computeAutoReleaseEligibility({ releasePolicy: "AUTO" }),
    ).toBe(false)
    expect(
      service().computeSettlementReleasePolicy(
        { verifyMethod: "AUTO", amount: 100 },
        { tier: "TRUSTED" },
        [{ type: "URL_REUSED" }],
        cleanHistory,
      ),
    ).toBe("MANUAL")
  })
})
