import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const repoRoot = resolve(__dirname, "../../../../../..")
const read = (path: string) => readFileSync(resolve(repoRoot, path), "utf8")

describe("payout financial invariants", () => {
  it("claims both provider sends before external I/O and fingerprints routing", () => {
    const source = read(
      "apps/api/src/modules/publisher-payouts/payout-execution.service.ts",
    )
    const execute = source.slice(
      source.indexOf("async executeWithdrawal"),
      source.indexOf("async retryExecution"),
    )

    expect(execute).toContain('stage: "PROVIDER_SEND_CLAIMED"')
    expect(execute).toContain('stage: "BANK_PAYOUT_SEND_CLAIMED"')
    expect(execute).toContain("recipientFingerprint")
    expect(execute).toContain("encryptedDetailsFingerprint")
    expect(execute).toContain("providerAccountFingerprint")
    expect(execute).toContain("configFingerprint")
    expect(execute).toContain("PROVIDER_OUTCOME_UNKNOWN")
    expect(execute).not.toMatch(/data:\s*\{\s*status:\s*"FAILED"/)
  })

  it("enforces one active-or-completed money movement and immutable terminals", () => {
    const migration = read(
      "packages/database/prisma/migrations/20260729100000_payout_completion_evidence/migration.sql",
    )

    expect(migration).toContain(
      "PayoutExecution_one_money_movement_per_withdrawal_key",
    )
    expect(migration).toContain(
      `WHERE "status" IN ('PENDING', 'PROCESSING', 'COMPLETED')`,
    )
    expect(migration).toContain(
      `IF TG_OP = 'UPDATE' AND OLD."status" = 'COMPLETED' THEN`,
    )
    expect(migration).toContain(
      `BEFORE INSERT OR UPDATE OR DELETE ON "PayoutExecution"`,
    )
    expect(migration).toContain(
      "Payout execution rows are financial evidence and cannot be deleted",
    )
    expect(migration).toContain(
      "Payout executions cannot be inserted in a terminal state",
    )
    expect(migration).toContain(
      "LEGACY_UNVERIFIED cannot be used for a new payout completion",
    )
    expect(migration).toContain(
      `IF OLD."status" IN ('COMPLETED', 'REJECTED', 'REVERSED') THEN`,
    )
    expect(migration).toContain(
      `BEFORE INSERT OR UPDATE OR DELETE ON "Withdrawal"`,
    )
    expect(migration).toContain(
      "Withdrawal completion requires exactly one completed payout execution",
    )
    const beginAt = migration.indexOf("BEGIN;")
    const timeoutAt = migration.indexOf("SET LOCAL lock_timeout = '5s';")
    const lockAt = migration.indexOf(`LOCK TABLE
  "AuditLog",
  "PayoutExecution",
  "PayoutMethod",
  "PayoutProvider",
  "Withdrawal"
IN SHARE MODE;`)
    const preflightAt = migration.indexOf("-- Read-only preflight")
    expect(beginAt).toBeGreaterThanOrEqual(0)
    expect(timeoutAt).toBeGreaterThan(beginAt)
    expect(lockAt).toBeGreaterThan(timeoutAt)
    expect(preflightAt).toBeGreaterThan(lockAt)
    expect(migration.trimEnd()).toMatch(/COMMIT;$/)
    expect(migration).toContain(
      "Withdrawal rows are financial evidence and cannot be deleted",
    )
    expect(migration).toContain("PayoutExecution_identity_guard")
    expect(migration).toContain("Withdrawal_financial_provenance_guard")
    expect(migration).toContain("WithdrawalAllocation_evidence_guard")
    expect(migration).toContain("PublisherProviderAccount_identity_guard")
    expect(migration).toContain(
      "Publisher provider accounts are routing evidence and cannot be deleted",
    )
    expect(migration).toContain("PayoutExecutionClaim_authority_guard")
    expect(migration).toContain(
      "Payout execution claims are financial authority and cannot be deleted",
    )
    expect(migration).toContain(
      "PayoutProvider_config_ciphertext_or_empty_check",
    )
    expect(migration).toContain(
      "provider config must be encrypted ciphertext or an empty object",
    )
    expect(migration).toContain(
      "Provider-send claim and execution stage must commit atomically",
    )
    expect(migration).toContain("Withdrawal command envelope is immutable")
    expect(migration).toContain(
      "A processing withdrawal requires exactly one processing payout execution",
    )
    expect(migration).toContain("Withdrawal_actor_timestamp_pairs_check")
    expect(migration).toContain("PayoutWebhookEvent_evidence_guard")
    expect(migration).toContain(
      "Payout webhook normalized evidence is immutable",
    )
    expect(migration).toContain(
      "Invalid payout webhook inbox lifecycle transition",
    )
    expect(migration).toContain(
      "Payout execution command identity is immutable",
    )
    expect(migration).toContain("Payout provider references are append-once")
    expect(migration).toContain(
      "Provider cancellation requires matching typed Stripe reversal evidence",
    )
    expect(migration).toContain(
      "Withdrawal reopen requires the latest payout execution to have typed cancellation evidence",
    )
    expect(migration).toContain(
      "Withdrawal reversal requires typed provider cancellation or reversal evidence",
    )
    expect(migration).toContain("WithdrawalAllocation_evidence_guard")
    expect(migration).toContain(
      "Rejected withdrawals require every reserved allocation to be released",
    )
  })

  it("routes worker completion through canonical evidence and quarantines contradictions", () => {
    const worker = read("apps/worker/src/processors/payout.processor.ts")

    expect(worker).toContain("finalizePayoutExecution")
    expect(worker).toContain('"QUARANTINED"')
    expect(worker).toContain("PAYOUT_WEBHOOK_UNMATCHED_TERMINAL_QUARANTINED")
    expect(worker).toContain("providerAccountExternalId")
    expect(worker).toContain('"BANK_PAYOUT_RECOVERY_REQUIRED"')
    expect(worker).toContain("execution.providerPayoutId ??")
    expect(worker).toContain('"BANK_PAYOUT_SEND_CLAIMED"')
    expect(worker).toContain('assertFinanceOperationAllowed("recovery")')
    expect(worker).toContain("err instanceof StripeConfigurationError")
    expect(worker).toContain('"STRIPE_KEY_MISSING"')
    expect(worker).toContain("assertStripeFinancialObjectMode")
    expect(worker).toContain("secretKey: process.env.STRIPE_SECRET_KEY")
    // Polling and failure terminalization each re-read the current credential
    // at their own financial mutation boundary.
    expect(worker.match(/process\.env\.STRIPE_SECRET_KEY/g)).toHaveLength(2)
    expect(worker).not.toMatch(
      /logger\.[a-z]+\([^\n]*process\.env\.STRIPE_SECRET_KEY/,
    )
    expect(worker).not.toContain(
      '"TRANSFER_RECOVERY_REQUIRED",\n          "BANK_PAYOUT_RECOVERY_REQUIRED"',
    )
    expect(worker).not.toContain("normalizeProviderWebhook")
  })

  it("keeps legacy failed-withdrawal reversal fail-closed", () => {
    const service = read(
      "apps/api/src/modules/publisher-payouts/publisher-payouts.service.ts",
    )
    expect(service).toContain("PAYOUT_REVERSAL_EVIDENCE_REQUIRED")
    expect(service).toContain(
      "Durable provider-confirmed failure or cancellation evidence",
    )
  })

  it("routes cancellation recovery through its exact lease instead of generic retry", () => {
    const service = read(
      "apps/api/src/modules/publisher-payouts/payout-execution.service.ts",
    )
    const financePage = read("apps/admin/src/app/dashboard/finance/page.tsx")
    const apiClient = read("packages/api-client/src/services/admin.ts")

    expect(service).toContain("freshCancellationLease")
    expect(service).toContain(
      "A provider cancellation call is already in progress",
    )
    expect(service).toContain("reclaimedCancellation")
    expect(financePage).toContain("canResumeCancellation")
    expect(financePage).toContain("Cancellation in progress")
    expect(financePage).toContain("Resume cancellation")
    expect(financePage).toContain("api.admin.cancelPayoutExecution")
    expect(apiClient).toContain("updatedAt: string")

    const executionActions = financePage.slice(
      financePage.indexOf("{executionsQ.data.map"),
      financePage.indexOf("{/* Evidence-bound completion"),
    )
    expect(executionActions).not.toMatch(
      /BANK_PAYOUT_RECOVERY_REQUIRED",\s*"CANCEL_REQUESTED"[\s\S]{0,500}retryExecution\.mutate/,
    )
  })
})
