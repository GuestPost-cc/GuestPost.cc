import fs from "node:fs"
import path from "node:path"
import { RLS_MODEL_NAMES } from "@guestpost/database"

const root = path.resolve(__dirname, "../../../..")
const migration = fs.readFileSync(
  path.join(
    root,
    "packages/database/prisma/migrations/20260908130000_full_application_rls_boundary/migration.sql",
  ),
  "utf8",
)
const activation = fs.readFileSync(
  path.join(root, "scripts/activate-full-rls.sql"),
  "utf8",
)
const emergencyDisable = fs.readFileSync(
  path.join(root, "scripts/emergency-disable-full-rls.sql"),
  "utf8",
)

function migrationModels(): string[] {
  const block = migration.match(
    /models constant text\[\] := ARRAY\[([\s\S]*?)\];/,
  )
  if (!block) throw new Error("full-boundary model array not found")
  return [...block[1].matchAll(/'([A-Za-z][A-Za-z0-9_]*)'/g)].map(
    (match) => match[1],
  )
}

describe("full application RLS boundary migration", () => {
  it("stages four explicit policy commands without replacing live ApiKey policies", () => {
    const models = migrationModels()
    expect(new Set(models).size).toBe(99)
    expect(models.sort()).toEqual([...RLS_MODEL_NAMES].sort())
    expect(migration).toContain("FOR SELECT USING")
    expect(migration).toContain("FOR INSERT WITH CHECK")
    expect(migration).toContain("FOR UPDATE USING")
    expect(migration).toContain("FOR DELETE USING")
    expect(migration).toContain("_full_boundary_select")
    expect(migration).toContain("_full_boundary_insert")
    expect(migration).toContain("_full_boundary_update")
    expect(migration).toContain("_full_boundary_delete")
    expect(migration).toContain("IF model_name = 'ApiKey' THEN")
    expect(activation).toContain('CREATE POLICY "ApiKey_full_boundary_select"')
    expect(activation).toContain(
      'DROP POLICY "ApiKey_select_active_organization_owner"',
    )
  })

  it("is inert until the separately confirmed atomic activation", () => {
    expect(migration).not.toMatch(
      /^ALTER TABLE public\."?[A-Za-z][A-Za-z0-9_]*"? ENABLE ROW LEVEL SECURITY;/m,
    )
    expect(activation).toContain("activate=YES is required")
    expect(activation).toContain("expected exactly 99 application tables")
    expect(activation).toContain("covered_model_count <> 98")
    expect(activation).toContain("total_policy_count <> 398")
    expect(activation).toContain("phase_one_api_key_policy_count <> 6")
    expect(activation).toContain("covered_model_count <> 99")
    expect(activation).toContain("policy_count <> 396")
    expect(activation).toContain("total_policy_count <> 396")
    expect(activation).toContain("ENABLE ROW LEVEL SECURITY")
    expect(activation).toContain("FORCE ROW LEVEL SECURITY")
    expect(activation).toMatch(/BEGIN;[\s\S]*COMMIT;/)
  })

  it("uses live authority rows and never grants a staff or worker bypass role", () => {
    expect(migration).toContain('FROM public."Membership"')
    expect(migration).toContain('FROM public."PublisherMembership"')
    expect(migration).toContain('FROM public."StaffMembership"')
    expect(migration).toContain("actor.banned = false")
    expect(migration).toContain("staff_role_in(ARRAY['SUPER_ADMIN'])")
    expect(migration).toContain("staff_role_in(ARRAY['OPERATIONS'])")
    expect(migration).toContain("staff_role_in(ARRAY['FINANCE'])")
    expect(migration).toContain("customer_organization_owner(")
    expect(migration).toContain("membership.role = 'OWNER'")
    expect(migration).not.toMatch(/BYPASSRLS/)
  })

  it("keeps public catalog reads filtered to approved rows", () => {
    expect(migration).toContain("listing.status = 'APPROVED'")
    expect(migration).toContain("listing.verified = true")
    expect(migration).toContain('website."isActive" = true')
    expect(migration).toContain("website.\"verificationStatus\" = 'VERIFIED'")
    expect(migration).toContain(
      "row_data->>'availability' IN ('AVAILABLE', 'WAITLIST')",
    )
    expect(migration).toContain("public_publisher(row_data->>'publisherId')")
    expect(migration).toContain(
      "row_data->>'userId' = guestpost_rls.actor_id()",
    )
    expect(migration).toContain('ADD COLUMN "reviewerName" text')
    expect(migration).toContain("WHEN 'WebsiteMetric'")
    expect(migration).not.toContain(
      "WHEN 'User'\n      THEN RETURN guestpost_rls.catalog_read",
    )
  })

  it("prevents tenant role escalation and last-owner lockout", () => {
    expect(migration).toContain("api_actor_command_allowed(")
    expect(migration).toContain("publisher_owner(target_id text)")
    expect(migration).toContain("enforce_membership_transition()")
    expect(migration).toContain("enforce_publisher_owner_transition()")
    expect(migration).toContain(
      "membership self-update is limited to accepting an unchanged pending invitation",
    )
    expect(migration).toContain(
      "cannot remove or demote the last active organization owner",
    )
    expect(migration).toContain("find_invitable_user(")
  })

  it("preserves the API-key boundary during emergency recovery", () => {
    expect(emergencyDisable).toContain("disable=EMERGENCY is required")
    expect(emergencyDisable).toContain(
      "relation.relname NOT IN ('_prisma_migrations', 'ApiKey')",
    )
    expect(emergencyDisable).toContain("DISABLE ROW LEVEL SECURITY")
  })
})
