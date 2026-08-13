import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationSql = fs.readFileSync(
  path.join(
    repoRoot,
    "packages/database/prisma/migrations/20260812102000_order_settled_lifecycle_removal/migration.sql",
  ),
  "utf8",
)

describe("order SETTLED lifecycle removal migration contract", () => {
  it("rebinds the Order status CHECK to the replacement enum", () => {
    const dropConstraint = migrationSql.indexOf(
      'DROP CONSTRAINT "Order_websiteId_required"',
    )
    const renameOldEnum = migrationSql.indexOf(
      'ALTER TYPE public."OrderStatus" RENAME TO "OrderStatus_before_settled_removal"',
    )
    const convertOrderStatus = migrationSql.indexOf(
      'ALTER TABLE public."Order"\n  ALTER COLUMN "status" TYPE public."OrderStatus"',
    )
    const addConstraint = migrationSql.indexOf(
      'ADD CONSTRAINT "Order_websiteId_required"',
    )
    const dropOldEnum = migrationSql.indexOf(
      'DROP TYPE public."OrderStatus_before_settled_removal"',
    )

    expect(dropConstraint).toBeGreaterThan(-1)
    expect(dropConstraint).toBeLessThan(renameOldEnum)
    expect(addConstraint).toBeGreaterThan(convertOrderStatus)
    expect(addConstraint).toBeLessThan(dropOldEnum)
    expect(migrationSql).toMatch(
      /ADD CONSTRAINT "Order_websiteId_required"[\s\S]*"status" = 'DRAFT'::public\."OrderStatus"/,
    )
  })

  it("casts through text when replacing both enum types", () => {
    expect(migrationSql).toMatch(
      /ALTER COLUMN "status" TYPE public\."OrderStatus"\s+USING \("status"::text::public\."OrderStatus"\)/,
    )
    expect(migrationSql).toMatch(
      /ALTER COLUMN "eventType" TYPE public\."OrderEventType"[\s\S]*WHEN "eventType"::text <> 'SETTLED'/,
    )
    expect(migrationSql).toMatch(
      /END::public\."OrderEventType"[\s\S]*DROP TYPE public\."OrderEventType_before_settled_split"/,
    )
  })
})
