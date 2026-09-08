import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationSql = fs.readFileSync(
  path.join(
    repoRoot,
    "packages/database/prisma/migrations/20260811133000_delivery_url_claim_fence/migration.sql",
  ),
  "utf8",
)
const financeRehearsalScript = fs.readFileSync(
  path.join(repoRoot, "scripts/verify-financial-migration-upgrade.sh"),
  "utf8",
)
const serializableReaderSql = fs.readFileSync(
  path.join(
    repoRoot,
    "scripts/fixtures/delivery-url-fence-serializable-reader.sql",
  ),
  "utf8",
)
const concurrentWriterSql = fs.readFileSync(
  path.join(
    repoRoot,
    "scripts/fixtures/delivery-url-fence-concurrent-writer.sql",
  ),
  "utf8",
)
const runtimeGrantSql = fs.readFileSync(
  path.join(repoRoot, "scripts/fixtures/grant-delivery-url-fence-runtime.sql"),
  "utf8",
)
const rlsProvisioningSql = fs.readFileSync(
  path.join(repoRoot, "scripts/provision-rls-roles.sql"),
  "utf8",
)
const rlsRolloutRunbook = fs.readFileSync(
  path.join(repoRoot, "docs/RLS_ROLLOUT.md"),
  "utf8",
)

describe("delivery URL claim fence migration contract", () => {
  it("uses the same advisory namespace as the application lock", () => {
    expect(migrationSql).toContain("hashtextextended(claim_url, 6182047)")
    expect(migrationSql).toMatch(/pg_advisory_xact_lock\(claim_lock_key\)/)
    expect(migrationSql).toMatch(
      /CREATE FUNCTION public\."acquire_delivery_url_claim_fence"\(claim_url TEXT\)\s+RETURNS BOOLEAN/,
    )
    expect(migrationSql).toMatch(/RETURN TRUE;/)
  })

  it("fences every mutation and preserves the existing Order-to-URL lock order", () => {
    const orderTriggerName = "OrderDeliveryVersion_settlement_order_lock"
    const urlTriggerName = "OrderDeliveryVersion_url_claim_lock"

    expect(orderTriggerName.localeCompare(urlTriggerName)).toBeLessThan(0)
    expect(migrationSql).toMatch(
      /CREATE TRIGGER "OrderDeliveryVersion_url_claim_lock"\s+BEFORE INSERT OR UPDATE OR DELETE ON public\."OrderDeliveryVersion"/,
    )
    expect(migrationSql).toContain(
      "OrderDeliveryVersion_settlement_order_lock trigger sorts first",
    )
    expect(migrationSql).toMatch(
      /LOCK TABLE public\."OrderDeliveryVersion" IN SHARE ROW EXCLUSIVE MODE/,
    )
    expect(migrationSql).toMatch(/empty normalized URL exists/)
    expect(migrationSql).toMatch(/LENGTH\(BTRIM\("normalizedUrl"\)\) = 0/)
    expect(migrationSql).toMatch(
      /EXECUTE FUNCTION public\."fence_delivery_url_claim_mutation"\(\)/,
    )
  })

  it("backfills and advances an MVCC row fence in deterministic lock order", () => {
    expect(migrationSql).toMatch(/CREATE TABLE public\."DeliveryUrlClaimFence"/)
    expect(migrationSql).toMatch(
      /SELECT DISTINCT "normalizedUrl", 0\s+FROM public\."OrderDeliveryVersion"/,
    )
    expect(migrationSql).toMatch(
      /FROM public\."DeliveryUrlClaimFence"[\s\S]*FOR UPDATE/,
    )
    expect(migrationSql).toMatch(
      /UPDATE public\."DeliveryUrlClaimFence"[\s\S]*SET "version" = "version" \+ 1/,
    )
    expect(migrationSql).toMatch(/ELSIF old_lock_key < new_lock_key THEN/)
    expect(migrationSql).toMatch(
      /ELSIF old_lock_key = new_lock_key THEN[\s\S]*ELSIF old_lock_key < new_lock_key THEN/,
    )
  })

  it("cannot be redirected through a caller-controlled temporary schema", () => {
    expect(
      migrationSql.match(/SECURITY INVOKER\s+SET search_path = pg_catalog/g),
    ).toHaveLength(2)
    expect(migrationSql).not.toMatch(
      /SECURITY INVOKER\s+SET search_path = pg_catalog, public/,
    )
    expect(migrationSql).toMatch(/INSERT INTO public\."DeliveryUrlClaimFence"/)
    expect(migrationSql).toMatch(
      /PERFORM public\."acquire_delivery_url_claim_fence"/,
    )
    expect(migrationSql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\."acquire_delivery_url_claim_fence"\(text\)[\s\S]*FROM PUBLIC/,
    )
    expect(migrationSql).toMatch(
      /REVOKE EXECUTE ON FUNCTION public\."fence_delivery_url_claim_mutation"\(\)[\s\S]*FROM PUBLIC/,
    )
    expect(migrationSql).toMatch(
      /REVOKE ALL ON TABLE public\."DeliveryUrlClaimFence" FROM PUBLIC/,
    )
    expect(migrationSql).toMatch(
      /ALTER FUNCTION public\."lock_settlement_blocker_order"\(\)[\s\S]*SET search_path = pg_catalog, public, pg_temp/,
    )
  })

  it("rehearses the runtime role and a stale SERIALIZABLE reader on PostgreSQL", () => {
    expect(financeRehearsalScript).toContain(
      "scripts/fixtures/post-delivery-url-fence-runtime-assertions.sql",
    )
    expect(financeRehearsalScript).toContain(
      "scripts/fixtures/delivery-url-fence-serializable-reader.sql",
    )
    expect(financeRehearsalScript).toContain(
      "scripts/fixtures/delivery-url-fence-serializable-reader-release.sql",
    )
    expect(financeRehearsalScript).toContain(
      "scripts/fixtures/delivery-url-fence-concurrent-writer.sql",
    )
    expect(financeRehearsalScript).toContain("mkfifo")
    expect(serializableReaderSql).not.toContain("pg_sleep")
    expect(concurrentWriterSql).toMatch(/IF NOT FOUND THEN/)
    expect(runtimeGrantSql).toMatch(/GRANT USAGE ON SCHEMA public/)
    expect(runtimeGrantSql).toMatch(/REVOKE CREATE ON SCHEMA public/)
    expect(financeRehearsalScript).toContain("ERROR:  40001:")
  })

  it("preserves the exact direct fence grant in the staged RLS role topology", () => {
    expect(rlsProvisioningSql).toContain("\\set ON_ERROR_STOP on")
    expect(rlsProvisioningSql).toMatch(
      /database_name is required[\s\S]*\\quit 3/,
    )
    expect(rlsProvisioningSql).toMatch(
      /SELECT current_database\(\) = :'database_name' AS target_database_matches \\gset[\s\S]*\\if :target_database_matches[\s\S]*\\quit 3/,
    )
    expect(rlsProvisioningSql).toContain(
      "GRANT USAGE, CREATE ON SCHEMA public TO guestpost_schema_owner",
    )
    expect(rlsProvisioningSql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\."acquire_delivery_url_claim_fence"\(text\)\s+TO guestpost_api_group, guestpost_worker_group/,
    )
    expect(rlsProvisioningSql).toContain(
      "REVOKE ALL PRIVILEGES ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC",
    )
    const managedAclCleanup = rlsProvisioningSql.indexOf(
      "REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM\n  guestpost_api_group",
    )
    const compatibilityGrant = rlsProvisioningSql.indexOf(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO guestpost_api_group",
    )
    expect(managedAclCleanup).toBeGreaterThan(-1)
    expect(compatibilityGrant).toBeGreaterThan(managedAclCleanup)
    expect(rlsProvisioningSql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE guestpost_schema_owner IN SCHEMA public REVOKE ALL ON FUNCTIONS FROM\n  guestpost_api_group",
    )
  })

  it("atomically rebuilds the managed graph and leaves credentials disabled", () => {
    const transactionStart = rlsProvisioningSql.indexOf("BEGIN;\n\nDO $roles$")
    const membershipCleanup = rlsProvisioningSql.indexOf("DO $memberships$")
    const intendedMemberships = rlsProvisioningSql.indexOf(
      "GRANT guestpost_schema_owner TO guestpost_migrator",
    )
    const transactionCommit = rlsProvisioningSql.indexOf("\nCOMMIT;")

    expect(transactionStart).toBeGreaterThan(-1)
    expect(membershipCleanup).toBeGreaterThan(-1)
    expect(membershipCleanup).toBeGreaterThan(transactionStart)
    expect(intendedMemberships).toBeGreaterThan(membershipCleanup)
    expect(transactionCommit).toBeGreaterThan(intendedMemberships)
    expect(rlsProvisioningSql).toContain("'REVOKE %I FROM %I'")
    expect(rlsProvisioningSql).toContain(
      "ALTER ROLE guestpost_api_runtime NOLOGIN",
    )
    expect(rlsProvisioningSql).not.toMatch(
      /^ALTER ROLE guestpost_(?:migrator|api_runtime|auth_runtime|worker_runtime|reporting_runtime) LOGIN;$/m,
    )
    expect(
      rlsProvisioningSql.match(/^GRANT guestpost_\w+ TO guestpost_\w+ .+;$/gm),
    ).toEqual([
      "GRANT guestpost_schema_owner TO guestpost_migrator WITH INHERIT FALSE, SET TRUE;",
      "GRANT guestpost_api_group TO guestpost_api_runtime WITH INHERIT TRUE, SET FALSE;",
      "GRANT guestpost_auth_group TO guestpost_auth_runtime WITH INHERIT TRUE, SET FALSE;",
      "GRANT guestpost_worker_group TO guestpost_worker_runtime WITH INHERIT TRUE, SET FALSE;",
      "GRANT guestpost_reporting_group TO guestpost_reporting_runtime WITH INHERIT TRUE, SET FALSE;",
    ])
    expect(rlsProvisioningSql).toMatch(
      /ALTER ROLE guestpost_migrator IN DATABASE :"database_name"\s+SET role TO 'guestpost_schema_owner'/,
    )
    expect(rlsProvisioningSql).toContain(
      'ALTER ROLE guestpost_api_runtime IN DATABASE :"database_name" RESET role',
    )
  })

  it("requires object-specific grants in every relation-creating migration", () => {
    expect(rlsRolloutRunbook).toContain("## Required migration grant checklist")
    expect(rlsRolloutRunbook).toMatch(
      /Every\s+migration that creates a table or sequence/,
    )
    expect(rlsRolloutRunbook).toContain(
      "reject blanket application-role default privileges",
    )
    expect(rlsRolloutRunbook).toContain(
      "FROM information_schema.table_privileges",
    )
    expect(rlsRolloutRunbook).toContain("WITH public_acl AS")
    expect(rlsRolloutRunbook).toContain("leaves all credential roles `NOLOGIN`")
  })
})
