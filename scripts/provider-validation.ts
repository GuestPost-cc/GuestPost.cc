/**
 * Retired payout-provider validation harness.
 *
 * The former script inserted PROCESSING Withdrawal/PayoutExecution rows
 * directly. That bypassed request-time reservation, allocation provenance,
 * immutable routing snapshots, and provider evidence, so the financial
 * database guards now reject it by design.
 */

const replacement = [
  "scripts/provider-validation.ts is retired; its direct payout fixtures bypassed financial invariants.",
  "Use these maintained validation paths instead:",
  "  1. bash scripts/setup-integration-test-db.sh",
  "  2. cd apps/api && ./node_modules/.bin/jest --config jest.config.js --selectProjects integration --runInBand src/__tests__/integration/financial",
  "  3. Follow docs/STRIPE_STAGING_RUNBOOK.md for signed Stripe sandbox validation.",
].join("\n")

console.error(replacement)
process.exitCode = 2
