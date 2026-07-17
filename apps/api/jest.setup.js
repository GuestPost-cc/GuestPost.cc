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
  process.env.DATABASE_URL =
    "postgresql://test:test@localhost:5432/test_jest_default"
}

// Phase 7.11 — OAuth state cookie attributes.
//
// buildAuthOptions() (packages/auth/src/index.ts) enforces these at build
// time — it throws if either is unset, converting silent misconfiguration
// into a clear startup error. The back-compat `auth` singleton at the bottom
// of that file calls buildAuthOptions() unconditionally on import, so any spec
// that transitively imports @guestpost/auth needs these set before Jest
// evaluates the import. Mirrors the production contract: Lax + non-secure in
// dev/test (no HTTPS), None + Secure in prod (set via real .env in CI).
if (!process.env.OAUTH_STATE_COOKIE_SAMESITE) {
  process.env.OAUTH_STATE_COOKIE_SAMESITE = "Lax"
}
if (!process.env.OAUTH_STATE_COOKIE_SECURE) {
  process.env.OAUTH_STATE_COOKIE_SECURE = "false"
}

// The integrations provider registry is evaluated when AppModule is imported.
// Integration specs do not call Google, but the provider intentionally fails
// closed when its runtime credentials are absent. Use inert test-only values so
// the full application graph can be constructed without real OAuth secrets.
if (!process.env.GOOGLE_CLIENT_ID) {
  process.env.GOOGLE_CLIENT_ID = "ci-google-client-id"
}
if (!process.env.GOOGLE_CLIENT_SECRET) {
  process.env.GOOGLE_CLIENT_SECRET = "ci-google-client-secret"
}
