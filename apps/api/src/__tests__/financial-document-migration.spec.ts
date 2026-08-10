import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationPath = path.join(
  repoRoot,
  "packages/database/prisma/migrations/20260810120000_financial_document_attachments/migration.sql",
)

describe("financial document migration security contract", () => {
  const sql = fs.readFileSync(migrationPath, "utf8")

  it("uses a database sequence and unique document identity", () => {
    expect(sql).toMatch(
      /CREATE SEQUENCE "FinancialDocument_sequenceNumber_seq"/,
    )
    expect(sql).toMatch(/FinancialDocument_sequenceNumber_key/)
    expect(sql).toMatch(/FinancialDocument_dedupKey_key/)
  })

  it("enforces exact non-negative totals and bounded attachment metadata", () => {
    expect(sql).toMatch(/"total" = "subtotal" \+ "taxAmount"/)
    expect(sql).toMatch(/"attachmentSize" BETWEEN 1 AND 5242880/)
    expect(sql).toMatch(/"attachmentSha256" ~ '\^\[0-9a-f\]\{64\}\$'/)
  })

  it("rejects updates and deletes of issued financial documents", () => {
    expect(sql).toMatch(/CREATE TRIGGER "FinancialDocument_immutable_update"/)
    expect(sql).toMatch(/CREATE TRIGGER "FinancialDocument_immutable_delete"/)
    expect(sql).toMatch(/issued financial documents are immutable/)
  })

  it("keeps tax identity fields paired", () => {
    expect(sql).toMatch(/BillingProfile_tax_pair_check/)
    expect(sql).toMatch(/"taxIdType" IS NULL AND "taxId" IS NULL/)
  })
})
