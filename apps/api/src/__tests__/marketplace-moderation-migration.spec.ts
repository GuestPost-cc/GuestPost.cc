import { readFileSync } from "node:fs"
import { join } from "node:path"

const migration = readFileSync(
  join(
    process.cwd(),
    "../..",
    "packages/database/prisma/migrations/20260821120000_marketplace_moderation/migration.sql",
  ),
  "utf8",
)
const legacyMessageCorrection = readFileSync(
  join(
    process.cwd(),
    "../..",
    "packages/database/prisma/migrations/20260821130000_marketplace_moderation_legacy_message_correction/migration.sql",
  ),
  "utf8",
)

describe("marketplace moderation migration", () => {
  it("creates append-only evidence with exact target constraints", () => {
    expect(migration).toContain('CREATE TABLE public."ModerationEvent"')
    expect(migration).toContain("ModerationEvent_exact_scope_target_check")
    expect(migration).toContain("ModerationEvent_actor_authority_check")
    expect(migration).toContain("ModerationEvent_append_only_guard")
    expect(migration).toContain("BEFORE UPDATE OR DELETE")
    expect(migration).toContain("ModerationEvent_truncate_guard")
    expect(migration).toContain("BEFORE TRUNCATE")
    expect(
      migration.match(/ON DELETE RESTRICT ON UPDATE RESTRICT/g),
    ).toHaveLength(3)
  })

  it("backfills ambiguous legacy holds conservatively", () => {
    expect(migration).toContain("LEGACY_ORIGIN_UNKNOWN")
    expect(migration).toContain('"activeModerationPreviousStatus" = NULL')
    expect(migration).toContain('"activeModerationPreviousActive" = NULL')
    expect(migration).not.toMatch(
      /"activeModerationPreviousStatus"\s*=\s*'APPROVED'/,
    )
  })

  it("does not rewrite listing status while backfilling website availability", () => {
    const websiteBackfill = migration.slice(
      migration.indexOf("'legacy-website-'"),
      migration.indexOf(
        'CREATE FUNCTION public."reject_moderation_event_mutation"',
      ),
    )
    expect(websiteBackfill).not.toContain('UPDATE public."MarketplaceListing"')
  })

  it("corrects only unchanged current legacy projections in a forward migration", () => {
    expect(legacyMessageCorrection).toContain(
      'UPDATE public."MarketplaceListing" listing',
    )
    expect(legacyMessageCorrection).toContain('UPDATE public."Website" website')
    expect(legacyMessageCorrection).toContain(
      "A GuestPost Super Admin must review it before restoration.",
    )
    expect(legacyMessageCorrection).toContain(
      "event.\"id\" = 'legacy-listing-' || listing.\"id\" || '-paused'",
    )
    expect(legacyMessageCorrection).toContain(
      "event.\"id\" = 'legacy-website-' || website.\"id\" || '-inactive'",
    )
    expect(legacyMessageCorrection).toContain('listing."moderationVersion" = 1')
    expect(legacyMessageCorrection).toContain('website."moderationVersion" = 1')
    expect(legacyMessageCorrection).not.toContain(
      'UPDATE public."ModerationEvent"',
    )
    expect(legacyMessageCorrection).not.toMatch(/DROP|DISABLE TRIGGER/)
  })
})
