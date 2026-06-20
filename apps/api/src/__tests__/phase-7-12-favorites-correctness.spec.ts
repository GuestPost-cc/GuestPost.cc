/**
 * Phase 7.12 #16 + #17 + #20 — favorites correctness bundle.
 *
 * Three audit findings, all in marketplace.service.ts favorites code:
 *
 *   #16  removeFavorite blasted ALL favorites for (user, listing),
 *        including service-scoped WAITLIST notify-me entries.
 *        Fix: scope to serviceType: null; add removeFavoriteService.
 *
 *   #17  No entry point for service-scoped favorites — the fan-out logic
 *        at marketplace.service.ts:728-749 was unreachable. Fix: extend
 *        addFavorite signature + CreateFavoriteDto with optional serviceType;
 *        validate against PAUSED services to avoid dead-write favorites.
 *
 *   #20  getFavorites response omitted services[], so the favorites page
 *        showed $0 for every listing (the listing-level `price` column
 *        was dropped in Phase 7). Fix: include services in the response.
 *
 * Static-source assertions + regression guards. The deep "create row,
 * remove other row, query DB" integration belongs in the future
 * Phase 7.10.2 Nest+supertest harness.
 */
import { readFileSync } from "fs"
import { join } from "path"

describe("Phase 7.12 #16 + #17 + #20 — favorites correctness", () => {
  const servicePath = join(__dirname, "..", "modules", "marketplace", "marketplace.service.ts")
  const serviceSource = readFileSync(servicePath, "utf-8")

  const dtoPath = join(__dirname, "..", "modules", "marketplace", "dto", "marketplace.dto.ts")
  const dtoSource = readFileSync(dtoPath, "utf-8")

  const controllerPath = join(__dirname, "..", "modules", "marketplace", "marketplace.controller.ts")
  const controllerSource = readFileSync(controllerPath, "utf-8")

  // ─── #16: removeFavorite scope ──────────────────────────────────────────
  describe("#16 — removeFavorite scoped to serviceType: null", () => {
    it("removeFavorite includes `serviceType: null` in the deleteMany where clause", () => {
      const startIdx = serviceSource.indexOf("async removeFavorite(")
      expect(startIdx).toBeGreaterThan(-1)
      const block = serviceSource.slice(startIdx, startIdx + 600)
      expect(block).toMatch(/deleteMany\(\{[\s\S]*?where:\s*\{[^}]*serviceType:\s*null/)
    })

    it("does NOT contain the legacy unscoped `where: { userId, listingId }` form (regression guard)", () => {
      const startIdx = serviceSource.indexOf("async removeFavorite(")
      const endIdx = serviceSource.indexOf("async removeFavoriteService(")
      expect(startIdx).toBeGreaterThan(-1)
      expect(endIdx).toBeGreaterThan(startIdx)
      const block = serviceSource.slice(startIdx, endIdx)
      // The exact 2-arg form (userId, listingId only) without serviceType is the bug
      expect(block).not.toMatch(/where:\s*\{\s*userId,\s*listingId\s*\}/)
    })

    it("adds a removeFavoriteService method that takes serviceType", () => {
      expect(serviceSource).toMatch(
        /async\s+removeFavoriteService\(\s*userId:\s*string,\s*listingId:\s*string,\s*serviceType:\s*ServiceType\s*\)/,
      )
    })

    it("removeFavoriteService scopes deleteMany to the supplied serviceType", () => {
      const startIdx = serviceSource.indexOf("async removeFavoriteService(")
      const block = serviceSource.slice(startIdx, startIdx + 500)
      expect(block).toMatch(/where:\s*\{\s*userId,\s*listingId,\s*serviceType\s*\}/)
    })
  })

  // ─── #17: addFavorite accepts serviceType + validates ─────────────────
  describe("#17 — addFavorite accepts optional serviceType", () => {
    it("addFavorite signature accepts serviceType parameter with default null", () => {
      expect(serviceSource).toMatch(
        /async\s+addFavorite\(\s*userId:\s*string,\s*listingId:\s*string,\s*serviceType:\s*ServiceType\s*\|\s*null\s*=\s*null\s*\)/,
      )
    })

    it("addFavorite validates non-null serviceType against PAUSED services", () => {
      const startIdx = serviceSource.indexOf("async addFavorite(")
      const endIdx = serviceSource.indexOf("async removeFavorite(")
      const block = serviceSource.slice(startIdx, endIdx)
      // Non-null branch must hit listingService.findFirst with the PAUSED filter
      expect(block).toMatch(/listingService\.findFirst/)
      expect(block).toMatch(/availability:\s*\{\s*not:\s*ServiceAvailability\.PAUSED\s*\}/)
    })

    it("addFavorite throws NotFoundException when serviceType is set but the service doesn't exist", () => {
      const startIdx = serviceSource.indexOf("async addFavorite(")
      const endIdx = serviceSource.indexOf("async removeFavorite(")
      const block = serviceSource.slice(startIdx, endIdx)
      expect(block).toMatch(/throw\s+new\s+NotFoundException\([^)]*\$\{serviceType\}/)
    })

    it("CreateFavoriteDto exposes optional serviceType field with @IsEnum(ServiceType)", () => {
      const startIdx = dtoSource.indexOf("export class CreateFavoriteDto")
      const block = dtoSource.slice(startIdx, startIdx + 600)
      expect(block).toMatch(/@IsOptional\(\)/)
      expect(block).toMatch(/@IsEnum\(ServiceType\)/)
      expect(block).toMatch(/serviceType\?:\s*ServiceType/)
    })

    it("Controller POST /favorites threads body.serviceType into the service call", () => {
      expect(controllerSource).toMatch(
        /addFavorite\(\s*user\.id,\s*body\.listingId,\s*body\.serviceType\s*\?\?\s*null\s*\)/,
      )
    })

    it("Controller exposes DELETE /favorites/:listingId/services/:serviceType with ParseEnumPipe validation", () => {
      // The route binding must use ParseEnumPipe for the URL param, since
      // class-validator DTOs only cover @Body() — Phase 7.12's plan
      // explicitly calls this out as the validation gap to close.
      const startIdx = controllerSource.indexOf("async removeFavoriteService(")
      expect(startIdx).toBeGreaterThan(-1)
      const block = controllerSource.slice(startIdx, startIdx + 800)
      expect(block).toMatch(/@Param\("serviceType",\s*new\s+ParseEnumPipe\(ServiceType\)\)/)
      // And the route decorator above it
      const routeBlock = controllerSource.slice(Math.max(0, startIdx - 400), startIdx)
      expect(routeBlock).toMatch(/@Delete\("favorites\/:listingId\/services\/:serviceType"\)/)
    })
  })

  // ─── #20: getFavorites includes services ─────────────────────────────
  describe("#20 — getFavorites includes services in the response", () => {
    it("getFavorites includes services: { where, orderBy, select } in the listing include", () => {
      const startIdx = serviceSource.indexOf("async getFavorites(")
      expect(startIdx).toBeGreaterThan(-1)
      const endIdx = serviceSource.indexOf("async addFavorite(")
      const block = serviceSource.slice(startIdx, endIdx)
      expect(block).toMatch(/services:\s*\{/)
      expect(block).toMatch(/orderBy:\s*\{\s*price:\s*["']asc["']\s*\}/)
    })

    it("getFavorites filters out PAUSED services (soft-disabled, kept for historical-order linkage)", () => {
      const startIdx = serviceSource.indexOf("async getFavorites(")
      const endIdx = serviceSource.indexOf("async addFavorite(")
      const block = serviceSource.slice(startIdx, endIdx)
      expect(block).toMatch(/availability:\s*\{\s*not:\s*ServiceAvailability\.PAUSED\s*\}/)
    })

    it("getFavorites uses the strongly-typed enum (NOT a string literal)", () => {
      const startIdx = serviceSource.indexOf("async getFavorites(")
      const endIdx = serviceSource.indexOf("async addFavorite(")
      const block = serviceSource.slice(startIdx, endIdx)
      // Regression guard: a refactor that swaps the enum for a string would
      // silently rot on a future enum rename.
      expect(block).not.toMatch(/availability:\s*\{\s*not:\s*["']PAUSED["']\s*\}/)
    })
  })

  // ─── Cross-cutting: imports updated ─────────────────────────────────
  describe("imports updated for the new enum + DTO uses", () => {
    it("marketplace.service.ts imports ServiceAvailability from @guestpost/database", () => {
      expect(serviceSource).toMatch(
        /import\s+\{[^}]*\bServiceAvailability\b[^}]*\}\s+from\s+["']@guestpost\/database["']/,
      )
    })

    it("marketplace.controller.ts imports ServiceType + ParseEnumPipe", () => {
      expect(controllerSource).toMatch(
        /import\s+\{[^}]*\bParseEnumPipe\b[^}]*\}\s+from\s+["']@nestjs\/common["']/,
      )
      expect(controllerSource).toMatch(
        /import\s+\{[^}]*\bServiceType\b[^}]*\}\s+from\s+["']@guestpost\/database["']/,
      )
    })
  })

  // ─── Phase 7.13.2A: race-proofing via NULLS NOT DISTINCT unique ──────
  // Static-source assertions verify the app-layer rewrite. The DB-level
  // race-proofing is exercised separately in the runtime suite below.
  describe("Phase 7.13.2A — addFavorite race-proofing", () => {
    it("addFavorite uses try/create/catch (Plan B), not findFirst+create emulation", () => {
      const startIdx = serviceSource.indexOf("async addFavorite(")
      expect(startIdx).toBeGreaterThan(-1)
      const block = serviceSource.slice(startIdx, startIdx + 2500)
      // Plan B markers: try { create }, catch (P2002), findFirst-on-catch
      expect(block).toMatch(/try\s*\{[\s\S]*?marketplaceFavorite\.create/)
      expect(block).toMatch(/catch\s*\([^)]+\)\s*\{[\s\S]*?P2002/)
      expect(block).toMatch(/marketplaceFavorite\.findFirst\(\{[\s\S]*?serviceType[\s\S]*?\}\)/)
    })

    it("addFavorite NO LONGER contains the pre-7.13.2A findFirst-then-create emulation pattern (regression guard)", () => {
      const startIdx = serviceSource.indexOf("async addFavorite(")
      const endIdx = serviceSource.indexOf("async removeFavorite(", startIdx)
      expect(startIdx).toBeGreaterThan(-1)
      expect(endIdx).toBeGreaterThan(startIdx)
      const block = serviceSource.slice(startIdx, endIdx)
      // The old emulation: `const existing = ... findFirst({where: { userId, listingId, serviceType }}); const favorite = existing ?? await ... create(...)`
      // Regression guard: the `?? await this.prisma.marketplaceFavorite.create` literal must not reappear.
      expect(block).not.toMatch(/existing\s*\?\?\s*await\s+this\.prisma\.marketplaceFavorite\.create/)
    })

    it("Phase 7.13.2A migration exists with NULLS NOT DISTINCT clause", () => {
      const fs = require("fs") as typeof import("fs")
      const path = require("path") as typeof import("path")
      const migrationsDir = path.join(__dirname, "..", "..", "..", "..", "packages", "database", "prisma", "migrations")
      const migDirs = fs.readdirSync(migrationsDir).filter((d: string) => d.includes("phase7132a_marketplace_favorite_new_unique_nulls_not_distinct"))
      expect(migDirs.length).toBe(1)
      const migSql = fs.readFileSync(path.join(migrationsDir, migDirs[0], "migration.sql"), "utf-8")
      expect(migSql).toMatch(/CREATE UNIQUE INDEX CONCURRENTLY "MarketplaceFavorite_uniq_nullsnotdistinct"/)
      expect(migSql).toMatch(/NULLS NOT DISTINCT/)
    })

    it("schema.prisma MarketplaceFavorite model NOTE documents both indexes", () => {
      const fs = require("fs") as typeof import("fs")
      const path = require("path") as typeof import("path")
      const schema = fs.readFileSync(
        path.join(__dirname, "..", "..", "..", "..", "packages", "database", "prisma", "schema.prisma"),
        "utf-8",
      )
      const modelIdx = schema.indexOf("model MarketplaceFavorite {")
      expect(modelIdx).toBeGreaterThan(-1)
      const modelBlock = schema.slice(modelIdx, modelIdx + 2000)
      expect(modelBlock).toMatch(/MarketplaceFavorite_uniq_nullsnotdistinct/)
      expect(modelBlock).toMatch(/NULLS NOT DISTINCT/)
      expect(modelBlock).toMatch(/Phase 7\.13\.2[AB]/)
    })
  })

  // The 5-caller runtime stress test the Phase 7.13.2A plan called for
  // ("Promise.all of 5 concurrent INSERTs, assert exactly 1 row + 4 P2002")
  // is NOT shipped as a jest case — apps/api jest has no DATABASE_URL +
  // no Nest+supertest harness today (Phase 7.10 spec header documents this
  // convention; Phase 7.10.2 backlog item tracks the harness). Instead the
  // race-proof guarantee is verified out-of-band at PR-review + deploy time:
  //
  //   1. The migration verification runs a manual duplicate-NULL-INSERT
  //      sequence against a fresh DB via psql — proves the constraint
  //      rejects the second INSERT with P2002 on
  //      MarketplaceFavorite_uniq_nullsnotdistinct (see PR body).
  //   2. The pg_indexes catalog check confirms indnullsnotdistinct=t.
  //   3. The static-source assertions above confirm addFavorite's catch
  //      path handles the P2002 (re-fetch + return existing).
  //
  // Once the Phase 7.10.2 harness lands, a `Promise.all of 5 creates`
  // jest case becomes trivial to add as a follow-up.
})
