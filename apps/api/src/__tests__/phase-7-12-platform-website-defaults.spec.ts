/**
 * Phase 7.12 #24 — Platform website + auto-listing defaults.
 *
 * Previously: createPlatformWebsite omitted verificationStatus (defaulted
 * to PENDING_VERIFICATION) and created auto-listings with status APPROVED.
 * Both wrong — the schema comment at packages/database/prisma/schema.prisma:466-467
 * literally says "Platform sites are created VERIFIED", and APPROVED listings
 * with zero services show "no services available" to customers.
 *
 * This spec validates the defaults at the static-source level (verifies the
 * code change without standing up a full Nest+Prisma harness). The deeper
 * integration-level "create site, query DB row" test belongs in the future
 * Phase 7.10.2 Nest+supertest harness.
 */
import { readFileSync } from "node:fs"
import { join } from "node:path"

describe("Phase 7.12 #24 — Platform website + auto-listing defaults", () => {
  const adminServicePath = join(
    __dirname,
    "..",
    "modules",
    "admin",
    "admin.service.ts",
  )
  const adminServiceSource = readFileSync(adminServicePath, "utf-8")

  // The createPlatformWebsite function is a single contiguous block; we
  // narrow asserts to that region so other admin endpoints (which may
  // legitimately use APPROVED listings or PENDING_VERIFICATION websites)
  // don't accidentally satisfy or violate these checks.
  const createPlatformWebsiteBlock = (() => {
    const startIdx = adminServiceSource.indexOf("async createPlatformWebsite(")
    expect(startIdx).toBeGreaterThan(-1)
    // The function ends at the next `async ` at the same indentation, or
    // the next `// ─` section comment, or EOF. Take the next 3000 chars
    // as a safe upper bound — the function is ~80 lines.
    return adminServiceSource.slice(startIdx, startIdx + 3500)
  })()

  describe("platform website is created VERIFIED", () => {
    it("createPlatformWebsite sets verificationStatus to WebsiteVerificationStatus.VERIFIED", () => {
      expect(createPlatformWebsiteBlock).toMatch(
        /verificationStatus:\s*WebsiteVerificationStatus\.VERIFIED/,
      )
    })

    it('uses the strongly-typed enum, not the string literal "VERIFIED"', () => {
      // Regression guard: a future refactor that swaps the enum for a string
      // would lose tsc protection against enum renames.
      expect(createPlatformWebsiteBlock).not.toMatch(
        /verificationStatus:\s*["']VERIFIED["']/,
      )
    })

    it("imports WebsiteVerificationStatus from @guestpost/database", () => {
      expect(adminServiceSource).toMatch(
        /import\s+\{[^}]*\bWebsiteVerificationStatus\b[^}]*\}\s+from\s+["']@guestpost\/database["']/,
      )
    })
  })

  describe("auto-listing is created DRAFT (not APPROVED)", () => {
    it("createPlatformWebsite auto-listing sets status to ListingStatus.DRAFT", () => {
      expect(createPlatformWebsiteBlock).toMatch(
        /status:\s*ListingStatus\.DRAFT/,
      )
    })

    it("does NOT use ListingStatus.APPROVED in the auto-listing block (regression guard)", () => {
      expect(createPlatformWebsiteBlock).not.toMatch(
        /status:\s*ListingStatus\.APPROVED/,
      )
    })
  })
})
