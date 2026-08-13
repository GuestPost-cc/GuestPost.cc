import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationSql = fs.readFileSync(
  path.join(
    repoRoot,
    "packages/database/prisma/migrations/20260812102500_validate_delivery_fraud_staff_disposition/migration.sql",
  ),
  "utf8",
)
const incidentQueries = fs.readFileSync(
  path.join(repoRoot, "docs/FINANCIAL_INCIDENT_QUERIES.md"),
  "utf8",
)
const migrationRehearsal = fs.readFileSync(
  path.join(repoRoot, "scripts/verify-financial-migration-upgrade.sh"),
  "utf8",
)
const postMigrationAssertions = fs.readFileSync(
  path.join(repoRoot, "scripts/fixtures/post-finance-hardening-assertions.sql"),
  "utf8",
)
const rootPackage = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"),
) as {
  scripts?: Record<string, string>
}

describe("delivery fraud staff-disposition validation migration", () => {
  it("validates retained history without rewriting evidence", () => {
    expect(migrationSql).toContain(
      'ALTER TABLE public."DeliveryFraudFlagResolution"',
    )
    expect(migrationSql).toContain(
      'VALIDATE CONSTRAINT "DeliveryFraudFlagResolution_staff_disposition_check"',
    )
    expect(migrationSql).toContain("SET LOCAL lock_timeout = '5s'")
    expect(migrationSql).toContain("SET LOCAL statement_timeout = '15min'")
    expect(migrationSql).toContain(
      "SET LOCAL search_path = pg_catalog, public, pg_temp",
    )
    expect(migrationSql).not.toMatch(/\b(?:UPDATE|DELETE|INSERT)\b/)
    expect(migrationRehearsal).toMatch(
      /20260812102500_validate_delivery_fraud_staff_disposition[\s\S]*CREATE DATABASE [\s\S]*negative_rehearsal_database[\s\S]*pre-delivery-fraud-disposition-validation-unsafe\.sql[\s\S]*DROP DATABASE [\s\S]*negative_rehearsal_database[\s\S]*DeliveryFraudFlagResolution_staff_disposition_check/,
    )
    expect(postMigrationAssertions).toMatch(
      /DeliveryFraudFlagResolution_staff_disposition_check[\s\S]*AND convalidated/,
    )
  })

  it("distinguishes pre-cutover missing mode evidence from new contradictions", () => {
    expect(incidentQueries).toMatch(
      /WITH evidence_cutover AS[\s\S]*MIN\(started_at\) AS started_at[\s\S]*20260729090000_payment_dispute_cases[\s\S]*\(e\."receivedAt" AT TIME ZONE 'UTC'\) >= cutover\.started_at/,
    )
    expect(incidentQueries).toMatch(
      /A mode-less Stripe row received before the evidence\s+migration started is preserved historical evidence/,
    )
  })

  it("loads the decorator-aware API compiler contract for operational CLIs", () => {
    expect(rootPackage.scripts?.["payout-encryption:verify"]).toMatch(
      /^TSX_TSCONFIG_PATH=apps\/api\/tsconfig\.json /,
    )
    expect(rootPackage.scripts?.["payout-encryption:rotate"]).toMatch(
      /^TSX_TSCONFIG_PATH=apps\/api\/tsconfig\.json /,
    )
  })
})
