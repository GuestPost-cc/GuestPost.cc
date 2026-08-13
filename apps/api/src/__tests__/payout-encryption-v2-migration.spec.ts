import * as fs from "node:fs"
import * as path from "node:path"

const repoRoot = path.resolve(__dirname, "..", "..", "..", "..")
const migrationSql = fs.readFileSync(
  path.join(
    repoRoot,
    "packages/database/prisma/migrations/20260812101000_payout_encryption_v2_keyring/migration.sql",
  ),
  "utf8",
)

function functionBody(name: string): string {
  const declaration = `CREATE FUNCTION "${name}"()`
  const declarationStart = migrationSql.indexOf(declaration)
  if (declarationStart < 0) throw new Error(`Missing SQL function ${name}`)

  const bodyStart = migrationSql.indexOf("AS $$", declarationStart)
  const bodyEnd = migrationSql.indexOf("\n$$;", bodyStart)
  if (bodyStart < 0 || bodyEnd < 0) {
    throw new Error(`Malformed SQL function ${name}`)
  }
  return migrationSql.slice(bodyStart, bodyEnd)
}

describe("payout encryption v2 migration contract", () => {
  const methodGuard = functionBody("guard_payout_method_encryption_v2")
  const providerGuard = functionBody("guard_payout_provider_encryption_v2")

  it("hard-cuts new encrypted writes over to canonical p2 envelopes", () => {
    expect(migrationSql).toMatch(/key_id !~ '\^\[A-Za-z0-9\._-\]\{1,64\}\$'/)
    expect(migrationSql).toMatch(/RETURN canonical = encoded/)
    expect(methodGuard).toMatch(
      /IF TG_OP = 'INSERT' THEN[\s\S]*NEW\."encryptionKeyVersion" <> 2[\s\S]*public\."is_valid_payout_v2_ciphertext"/,
    )
    expect(providerGuard).toMatch(
      /IF NEW\."config" = '\{\}'::jsonb[\s\S]*NEW\."configEncryptionKeyVersion" = 0 THEN[\s\S]*RETURN NEW/,
    )
    expect(providerGuard).toMatch(
      /NEW\."configEncryptionKeyVersion" <> 2[\s\S]*public\."is_valid_payout_v2_ciphertext"/,
    )
    expect(migrationSql).toMatch(
      /CREATE TRIGGER "PayoutMethod_encryption_v2_guard"\s+BEFORE INSERT OR UPDATE ON "PayoutMethod"/,
    )
    expect(migrationSql).toMatch(
      /CREATE TRIGGER "PayoutProvider_encryption_v2_guard"\s+BEFORE INSERT OR UPDATE ON "PayoutProvider"/,
    )
    expect(migrationSql).toMatch(
      /ALTER COLUMN "encryptionKeyVersion" DROP DEFAULT/,
    )
  })

  it("keeps valid legacy ciphertext readable but never rewrites or relabels it", () => {
    expect(migrationSql).toMatch(
      /ADD CONSTRAINT "PayoutMethod_encryption_envelope_check"[\s\S]*"encryptionKeyVersion" IN \(0, 1\)[\s\S]*"is_valid_legacy_payout_ciphertext"/,
    )
    expect(migrationSql).toMatch(
      /ADD CONSTRAINT "PayoutProvider_encryption_envelope_check"[\s\S]*"configEncryptionKeyVersion" IN \(0, 1\)[\s\S]*"is_valid_legacy_payout_ciphertext"/,
    )
    expect(migrationSql).not.toMatch(/\bUPDATE\s+"PayoutMethod"\b/)
    expect(migrationSql).not.toMatch(/\bUPDATE\s+"PayoutProvider"\b/)
    expect(methodGuard).toMatch(
      /IF details_changed THEN[\s\S]*NEW\."encryptionKeyVersion" <> 2/,
    )
    expect(providerGuard).toMatch(
      /IF config_changed THEN[\s\S]*NEW\."configEncryptionKeyVersion" <> 2/,
    )
  })

  it("rejects format downgrades and version-only relabeling", () => {
    expect(methodGuard).toMatch(
      /NEW\."encryptionKeyVersion" < OLD\."encryptionKeyVersion"/,
    )
    expect(methodGuard).toMatch(/IF format_changed AND NOT details_changed/)
    expect(providerGuard).toMatch(
      /NEW\."configEncryptionKeyVersion" < OLD\."configEncryptionKeyVersion"/,
    )
    expect(providerGuard).toMatch(/IF format_changed AND NOT config_changed/)
    expect(
      migrationSql.match(/cannot be relabeled without re-encryption/g),
    ).toHaveLength(2)
  })

  it("requires an exact aggregate-version CAS step for each ciphertext change", () => {
    expect(methodGuard).toMatch(
      /IF details_changed THEN[\s\S]*NEW\."version" IS DISTINCT FROM OLD\."version" \+ 1/,
    )
    expect(providerGuard).toMatch(
      /IF config_changed THEN[\s\S]*NEW\."version" IS DISTINCT FROM OLD\."version" \+ 1/,
    )
    expect(
      migrationSql.match(/changes require one aggregate version increment/g),
    ).toHaveLength(2)
  })

  it("makes every field authenticated as AAD immutable", () => {
    expect(methodGuard).toMatch(
      /NEW\."id" IS DISTINCT FROM OLD\."id"[\s\S]*NEW\."publisherId" IS DISTINCT FROM OLD\."publisherId"[\s\S]*NEW\."type" IS DISTINCT FROM OLD\."type"/,
    )
    expect(providerGuard).toMatch(
      /NEW\."id" IS DISTINCT FROM OLD\."id"[\s\S]*NEW\."name" IS DISTINCT FROM OLD\."name"/,
    )
  })
})
