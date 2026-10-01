import { isStagingSingleActorRepairEnabled } from "../reconciliation-repair.gates"

describe("staging single-actor repair gate", () => {
  const names = [
    "DEPLOYMENT_ENVIRONMENT",
    "FINANCE_RUNTIME_MODE",
    "FINANCIAL_RECONCILIATION_REPAIRS_ENABLED",
    "FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS",
    "FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MAKER_CHECKER_BYPASS",
  ] as const
  const originalValues = Object.fromEntries(
    names.map((name) => [name, process.env[name]]),
  )

  afterEach(() => {
    for (const name of names) {
      const originalValue = originalValues[name]
      if (originalValue === undefined) delete process.env[name]
      else process.env[name] = originalValue
    }
  })

  it("requires every explicit staging recovery control", () => {
    process.env.DEPLOYMENT_ENVIRONMENT = "staging"
    process.env.FINANCE_RUNTIME_MODE = "recovery_only"
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED = "true"
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS = "true"
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MAKER_CHECKER_BYPASS =
      "true"
    expect(isStagingSingleActorRepairEnabled()).toBe(true)

    process.env.DEPLOYMENT_ENVIRONMENT = "production"
    expect(isStagingSingleActorRepairEnabled()).toBe(false)

    process.env.DEPLOYMENT_ENVIRONMENT = "staging"
    delete process.env
      .FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MAKER_CHECKER_BYPASS
    expect(isStagingSingleActorRepairEnabled()).toBe(false)
  })
})
