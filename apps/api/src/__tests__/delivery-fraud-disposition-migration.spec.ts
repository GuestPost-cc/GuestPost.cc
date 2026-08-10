import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationPath = path.join(
  repoRoot,
  "packages/database/prisma/migrations/20260811120000_delivery_fraud_resolution_dispositions/migration.sql",
)

describe("delivery fraud disposition migration security contract", () => {
  const sql = fs.readFileSync(migrationPath, "utf8")

  it("enforces the classified disposition allowlist on new staff decisions", () => {
    expect(sql).toMatch(/DeliveryFraudFlagResolution_staff_disposition_check/)
    expect(sql).toMatch(/'FALSE_POSITIVE'/)
    expect(sql).toMatch(/'AUTHORIZED_REUSE'/)
    expect(sql).toMatch(/'RISK_ACCEPTED'/)
    expect(sql).toMatch(/\) NOT VALID;/)
  })

  it("requires Finance or Super Admin and a bounded evidence reference for known risk", () => {
    expect(sql).toMatch(/NOT IN \('SUPER_ADMIN', 'FINANCE'\)/)
    expect(sql).toMatch(
      /known delivery risk requires a bounded evidence reference/,
    )
    expect(sql).toMatch(/BETWEEN 1 AND 200/)
  })

  it("installs the classification guard as a BEFORE INSERT trigger", () => {
    expect(sql).toMatch(
      /CREATE TRIGGER "DeliveryFraudFlagResolution_classification_guard"/,
    )
    expect(sql).toMatch(/BEFORE INSERT ON "DeliveryFraudFlagResolution"/)
  })
})
