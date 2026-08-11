import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationRoot = path.join(repoRoot, "packages/database/prisma/migrations")
const enumSql = fs.readFileSync(
  path.join(
    migrationRoot,
    "20260811130000_fenced_email_delivery_dispatch/migration.sql",
  ),
  "utf8",
)
const evidenceSql = fs.readFileSync(
  path.join(
    migrationRoot,
    "20260811131000_fenced_email_delivery_evidence/migration.sql",
  ),
  "utf8",
)
const validationSql = fs.readFileSync(
  path.join(
    migrationRoot,
    "20260811131100_validate_fenced_email_delivery_evidence/migration.sql",
  ),
  "utf8",
)

describe("email delivery fencing migration contract", () => {
  it("commits the enum label in an earlier migration before using it", () => {
    expect(enumSql).toMatch(
      /ADD VALUE IF NOT EXISTS 'DELIVERY_UNCERTAIN' AFTER 'FAILED'/,
    )
    expect(enumSql).not.toMatch(/ALTER TABLE "CommunicationDelivery"/)
    expect(evidenceSql).not.toMatch(/ALTER TYPE/)
    expect(evidenceSql).toMatch(/ADD COLUMN "dispatchStartedAt"/)
  })

  it("requires dispatch evidence for terminal uncertainty", () => {
    expect(evidenceSql).toMatch(
      /CommunicationDelivery_uncertain_dispatch_check/,
    )
    expect(evidenceSql).toMatch(
      /"status" <> 'DELIVERY_UNCERTAIN'[\s\S]*"dispatchStartedAt" IS NOT NULL/,
    )
  })

  it("adds both checks without a blocking validation scan, then validates them", () => {
    expect(evidenceSql.match(/\) NOT VALID;/g)).toHaveLength(2)
    expect(evidenceSql).not.toMatch(/VALIDATE CONSTRAINT/)
    expect(validationSql).toMatch(
      /VALIDATE CONSTRAINT "CommunicationDelivery_dispatch_evidence_check"/,
    )
    expect(validationSql).toMatch(
      /VALIDATE CONSTRAINT "CommunicationDelivery_uncertain_dispatch_check"/,
    )
  })

  it("installs and validates each multi-statement contract atomically", () => {
    for (const sql of [enumSql, evidenceSql, validationSql]) {
      expect(sql.match(/\bBEGIN;/g)).toHaveLength(1)
      expect(sql.match(/\bCOMMIT;/g)).toHaveLength(1)
      expect(sql).toMatch(/SET LOCAL lock_timeout = '5s'/)
      expect(sql).toMatch(/SET LOCAL statement_timeout = '15min'/)
    }
  })

  it("allows dispatch evidence only for email states reached after SMTP begins", () => {
    expect(evidenceSql).toMatch(/"channel" = 'EMAIL'/)
    expect(evidenceSql).toMatch(/"attempts" > 0/)
    expect(evidenceSql).toMatch(/'PROCESSING'/)
    expect(evidenceSql).toMatch(/'SENT'/)
    expect(evidenceSql).toMatch(/'BOUNCED'/)
    expect(evidenceSql).not.toMatch(/'FAILED'/)
  })
})
