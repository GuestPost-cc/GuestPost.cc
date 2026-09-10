import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationRoot = path.join(repoRoot, "packages/database/prisma/migrations")

function migration(name: string): string {
  return fs.readFileSync(
    path.join(migrationRoot, name, "migration.sql"),
    "utf8",
  )
}

const baseSql = migration("20260910100000_security_query_hardening")
const validationSql = migration("20260910101100_validate_api_key_creator_fk")
const onlineIndexMigrations = [
  "20260910100100_api_key_creator_index",
  "20260910100200_report_dedup_index",
  "20260910100300_website_reverify_index",
  "20260910100400_order_auto_accept_index",
  "20260910100500_cancellation_stall_index",
  "20260910100600_payout_stale_stage_index",
  "20260910100700_audit_action_index",
  "20260910100800_audit_user_action_index",
  "20260910100900_listing_website_index",
  "20260910101000_review_listing_status_index",
].map(migration)

describe("security query hardening migration rollout", () => {
  it("installs the API-key foreign key without scanning legacy rows under the add lock", () => {
    expect(baseSql).toMatch(
      /ADD CONSTRAINT "ApiKey_createdByUserId_fkey"[\s\S]*ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;/,
    )
    expect(baseSql).not.toMatch(/VALIDATE CONSTRAINT/)
    expect(validationSql).toMatch(
      /VALIDATE CONSTRAINT "ApiKey_createdByUserId_fkey"/,
    )
  })

  it("builds each new index concurrently in its own single-statement migration", () => {
    expect(baseSql).not.toMatch(/CREATE (?:UNIQUE )?INDEX/)
    for (const sql of onlineIndexMigrations) {
      expect(sql.match(/CREATE (?:UNIQUE )?INDEX CONCURRENTLY/g)).toHaveLength(
        1,
      )
      expect(sql).not.toMatch(/\bBEGIN;|\bCOMMIT;/)
      expect(
        sql
          .split("\n")
          .filter((line) => !line.trimStart().startsWith("--"))
          .join("\n")
          .match(/;/g),
      ).toHaveLength(1)
    }
  })
})
