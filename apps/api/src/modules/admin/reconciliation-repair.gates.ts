export function isStagingSingleActorRepairEnabled() {
  return (
    process.env.DEPLOYMENT_ENVIRONMENT === "staging" &&
    process.env.FINANCE_RUNTIME_MODE === "recovery_only" &&
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_ENABLED === "true" &&
    process.env.FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MFA_BYPASS ===
      "true" &&
    process.env
      .FINANCIAL_RECONCILIATION_REPAIRS_STAGING_MAKER_CHECKER_BYPASS === "true"
  )
}
