import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationSql = fs.readFileSync(
  path.join(
    repoRoot,
    "packages/database/prisma/migrations/20260811132000_refund_financial_audience_repair/migration.sql",
  ),
  "utf8",
)
const financeRehearsalScript = fs.readFileSync(
  path.join(repoRoot, "scripts/verify-financial-migration-upgrade.sh"),
  "utf8",
)

describe("refund financial-audience repair migration", () => {
  it("authorizes only the customer and active organization owners", () => {
    expect(migrationSql).toMatch(/delivery\."userId" = order_row\."customerId"/)
    expect(migrationSql).toMatch(/membership\."status" = 'ACTIVE'/)
    expect(migrationSql).toMatch(/membership\."role" = 'OWNER'/)
    expect(migrationSql).toMatch(/delivery\."userId" IS NULL/)
    expect(migrationSql).toMatch(/notification\."userId" IS NULL/)
    expect(migrationSql).not.toMatch(/PublisherMembership/)
  })

  it("suppresses only pre-dispatch email and deletes unauthorized in-app rows", () => {
    expect(migrationSql).toMatch(
      /delivery\."status" IN \('PENDING', 'FAILED', 'PROCESSING'\)/,
    )
    expect(migrationSql).toMatch(/delivery\."dispatchStartedAt" IS NULL/)
    expect(migrationSql).toMatch(/DELETE FROM "Notification"/)
    expect(migrationSql).not.toMatch(
      /SET[\s\S]{0,500}"status" = 'SUPPRESSED'[\s\S]{0,500}'SENT'/,
    )
  })

  it("leaves durable incident evidence for terminal or uncertain disclosure", () => {
    expect(migrationSql).toMatch(
      /LEGACY_REFUND_AUDIENCE_DISCLOSURE_REVIEW_REQUIRED/,
    )
    expect(migrationSql).toMatch(/'DELIVERY_UNCERTAIN'/)
    expect(migrationSql).toMatch(/delivery\."dispatchStartedAt" IS NOT NULL/)
    expect(migrationSql).toMatch(/delivery\."attempts" > 0/)
    expect(migrationSql).toMatch(/'attempts', delivery\."attempts"/)
    expect(migrationSql).toMatch(/'reviewRequiredEmailCount'/)
    expect(migrationSql).toMatch(/'unauthorizedEmailSuppressed'/)
    expect(migrationSql).not.toMatch(/terminalUnauthorizedEmailCount/)
    expect(migrationSql).not.toMatch(/preDispatchEmailSuppressed/)
    expect(migrationSql).toMatch(/ON CONFLICT \("id"\) DO NOTHING/)
    expect(migrationSql).toMatch(/LEGACY_REFUND_AUDIENCE_PROJECTIONS_REPAIRED/)
  })

  it("scopes every repair audit to the canonical Order organization", () => {
    expect(migrationSql.match(/order_row\."organizationId",/g)).toHaveLength(2)
    expect(migrationSql).not.toMatch(/event\."organizationId",/)
  })

  it("repairs evidence and projections atomically behind a bounded writer barrier", () => {
    expect(migrationSql.match(/\bBEGIN;/g)).toHaveLength(1)
    expect(migrationSql.match(/\bCOMMIT;/g)).toHaveLength(1)
    expect(migrationSql).toMatch(/SET LOCAL lock_timeout = '5s'/)
    expect(migrationSql).toMatch(/SET LOCAL statement_timeout = '15min'/)
    expect(migrationSql).toMatch(
      /LOCK TABLE[\s\S]*"Order"[\s\S]*"Membership"[\s\S]*"CommunicationEvent"[\s\S]*"CommunicationDelivery"[\s\S]*"Notification"[\s\S]*"AuditLog"[\s\S]*IN SHARE MODE/,
    )
    expect(migrationSql).toMatch(/malformed or orphaned ORDER_REFUNDED event/)
  })

  it("runs the populated PostgreSQL fixture and an idempotent migration replay", () => {
    expect(financeRehearsalScript).toContain(
      "scripts/fixtures/pre-refund-audience-repair.sql",
    )
    expect(financeRehearsalScript).toContain(
      "scripts/fixtures/post-refund-audience-repair-assertions.sql",
    )
    expect(financeRehearsalScript).toContain(
      "scripts/fixtures/inject-refund-audience-repair-failure.sql",
    )
    expect(financeRehearsalScript).toContain(
      "scripts/fixtures/post-refund-audience-repair-rollback-assertions.sql",
    )
    expect(financeRehearsalScript).toMatch(
      /post-refund-audience-repair-assertions\.sql[\s\S]+run_rehearsal_file "\$\{migration_file\}"[\s\S]+post-refund-audience-repair-assertions\.sql/,
    )
  })
})
