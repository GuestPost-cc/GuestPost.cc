import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationSql = fs.readFileSync(
  path.join(
    repoRoot,
    "packages/database/prisma/migrations/20260812100500_wallet_reservation_release_ledger/migration.sql",
  ),
  "utf8",
)

describe("reservation-release migration contract", () => {
  it("uses immutable enum predicates for partial unique indexes", () => {
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX "Transaction_reservation_release_order_unique"[\s\S]*WHERE "type" = 'RELEASE'::public\."TransactionType"/,
    )
    expect(migrationSql).toMatch(
      /CREATE UNIQUE INDEX "Transaction_reservation_order_unique"[\s\S]*WHERE "type" = 'RESERVATION'::public\."TransactionType"/,
    )

    const indexSection = migrationSql.slice(
      migrationSql.indexOf(
        'CREATE UNIQUE INDEX "Transaction_reservation_release_order_unique"',
      ),
      migrationSql.indexOf('ALTER TABLE "Transaction"'),
    )
    expect(indexSection).not.toContain('"type"::TEXT')
  })
})
