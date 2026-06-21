/**
 * Phase 7.13.x — `createPrismaClient()` / `createPrismaAdapter()` helper.
 *
 * Two-layer spec:
 *   - Unit-test cases: runtime contract of the helpers themselves
 *   - Static-source assertions: both production callsites adopt the helpers
 *
 * Intentionally NOT asserted: introspection of PrismaPg internals (e.g.
 * confirming `max: 25` made it into the pool). PrismaPg doesn't expose pool
 * state publicly; using `instanceof PrismaPg` is also brittle against future
 * @prisma/adapter-pg class-shape changes. Instead we assert the helper's own
 * contract (throws when env missing, returns defined value when env present,
 * reads env at call time) + static-source proof that production callsites
 * route through the helper (the helper-adoption test is the regression guard
 * against silent reversion to the inline form).
 */
import { readFileSync } from "fs"
import { join } from "path"

const ORIGINAL_DATABASE_URL = process.env.DATABASE_URL

describe("Phase 7.13.x — createPrismaClient / createPrismaAdapter helpers", () => {
  afterEach(() => {
    process.env.DATABASE_URL = ORIGINAL_DATABASE_URL
    jest.resetModules()
  })

  describe("runtime contract: createPrismaAdapter", () => {
    it("THROWS 'DATABASE_URL is required' when env var is missing (runtime guard regression)", () => {
      jest.isolateModules(() => {
        delete process.env.DATABASE_URL
        const { createPrismaAdapter } = require("../../../../packages/database/src/create-prisma-client") as typeof import("@guestpost/database")
        expect(() => createPrismaAdapter()).toThrow("DATABASE_URL is required")
      })
    })

    it("returns a defined adapter value when DATABASE_URL is set", () => {
      jest.isolateModules(() => {
        process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test"
        const { createPrismaAdapter } = require("../../../../packages/database/src/create-prisma-client") as typeof import("@guestpost/database")
        const adapter = createPrismaAdapter()
        // Not asserting instanceof PrismaPg (brittle); just that the helper returns the contract value.
        expect(adapter).toBeDefined()
      })
    })

    it("reads process.env.DATABASE_URL at CALL time (not module-load time)", () => {
      jest.isolateModules(() => {
        // Import with env set — module load succeeds.
        process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test"
        const { createPrismaAdapter } = require("../../../../packages/database/src/create-prisma-client") as typeof import("@guestpost/database")
        // After import, unset env. Call should THROW — proves call-time read, not load-time read.
        delete process.env.DATABASE_URL
        expect(() => createPrismaAdapter()).toThrow("DATABASE_URL is required")
      })
    })
  })

  describe("runtime contract: createPrismaClient", () => {
    it("returns a defined PrismaClient when DATABASE_URL is set", () => {
      jest.isolateModules(() => {
        process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test"
        const { createPrismaClient } = require("../../../../packages/database/src/create-prisma-client") as typeof import("@guestpost/database")
        const client = createPrismaClient()
        expect(client).toBeDefined()
        // Cleanup — prevent test from holding the client open
        // (no $connect was called, but disconnect is idempotent).
        void (client as any).$disconnect?.()
      })
    })
  })

  describe("static-source: both production callsites adopt the helpers", () => {
    it("packages/database/src/index.ts uses createPrismaClient (singleton site adopted)", () => {
      const src = readFileSync(
        join(__dirname, "..", "..", "..", "..", "packages", "database", "src", "index.ts"),
        "utf-8",
      )
      expect(src).toMatch(/import\s*\{[^}]*createPrismaClient[^}]*\}\s*from\s*["']\.\/create-prisma-client["']/)
      expect(src).toMatch(/globalForPrisma\.prisma\s*\?\?\s*createPrismaClient\(\)/)
    })

    it("apps/api/src/common/prisma.service.ts uses createPrismaAdapter inside super(...) (NestJS site adopted)", () => {
      const src = readFileSync(
        join(__dirname, "..", "common", "prisma.service.ts"),
        "utf-8",
      )
      expect(src).toMatch(/import\s*\{[^}]*createPrismaAdapter[^}]*\}\s*from\s*["']@guestpost\/database["']/)
      expect(src).toMatch(/super\(\s*\{[\s\S]*?adapter:\s*createPrismaAdapter\(/)
    })

    it("NEITHER site contains the legacy inline `new PrismaPg({ connectionString:` form (regression guard)", () => {
      const singletonSrc = readFileSync(
        join(__dirname, "..", "..", "..", "..", "packages", "database", "src", "index.ts"),
        "utf-8",
      )
      const serviceSrc = readFileSync(
        join(__dirname, "..", "common", "prisma.service.ts"),
        "utf-8",
      )
      // The inline form is the pre-7.13.x shape both sites had. After adoption,
      // ONLY create-prisma-client.ts contains it.
      expect(singletonSrc).not.toMatch(/new\s+PrismaPg\s*\(\s*\{\s*connectionString:/)
      expect(serviceSrc).not.toMatch(/new\s+PrismaPg\s*\(\s*\{\s*connectionString:/)
    })
  })
})
