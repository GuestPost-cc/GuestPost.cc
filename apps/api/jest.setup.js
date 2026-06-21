// Phase 7.13.x — Test-env DATABASE_URL default.
//
// The createPrismaAdapter() helper in @guestpost/database throws at
// instantiation time when DATABASE_URL is unset (added intentionally as a
// runtime guard converting confusing first-query failures into clear
// startup errors). Specs that import @guestpost/auth or any other module
// that eagerly evaluates the global PrismaClient singleton would fail at
// import time without DATABASE_URL set.
//
// This sets a dummy connection string at jest bootstrap if env doesn't
// already provide one. The dummy URL is structurally valid but points at
// localhost:5432 — the real connection is never made because all specs
// that touch the prisma instance mock the Prisma methods. Specs that DO
// hit a real DB (none today; future Phase 7.10.2 integration harness)
// would override this via CI env.
//
// The Phase 7.13.x spec phase-7-13-x-create-prisma-client-helper.spec.ts
// explicitly tests "DATABASE_URL is required throws when env missing" —
// it controls its own env via jest.isolateModules + delete process.env
// inside the test callback, so the global default here doesn't interfere.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = "postgresql://test:test@localhost:5432/test_jest_default"
}
