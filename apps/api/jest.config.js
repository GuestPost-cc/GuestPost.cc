// Phase 7.10.2 — converted to jest projects shape. The unit project preserves
// the existing 47-suite / 652-test baseline exactly. The integration project is
// greenfield (greater testTimeout for slower DB-backed specs).
//
// Note: forceExit is root-level (jest's `projects` doesn't honor per-project
// forceExit). The unit project NEEDS it (grandfathered — Phase 7.8 PR #5
// stalled 40+min without it). Side effect: integration specs also get force-
// exited — see Phase 7.10.2.x backlog item for splitting into separate
// configs if integration leak-detection matters more than the unit baseline.
//
// Scripts:
//   pnpm test                — unit project only (existing fast feedback loop)
//   pnpm test:integration    — integration project only
//   pnpm test:all            — both projects

/** @type {import('jest').Config} */
//
// ts-jest isolatedModules:true — skips cross-file type-checking. Under the
// projects shape, ts-jest's default (full-program type-checking) trips on
// type errors in transitive deps (e.g. @guestpost/auth's better-auth imports)
// that are correctly mocked at RUNTIME via moduleNameMapper but TypeScript
// still sees the real types. isolatedModules treats each file independently,
// matching how jest actually runs them. The full-program type-check is the
// job of `pnpm typecheck` (turbo-driven, runs tsc --noEmit), not jest.
const sharedTransform = { "^.+\\.ts$": ["ts-jest", { isolatedModules: true }] }
const stripJsExtension = "^(\\.{1,2}/.*)\\.js$"
const stripJsMapping = { [stripJsExtension]: "$1" }
const baseModuleNameMapperFromSrc = {
  ...stripJsMapping,
  "^@guestpost/database$": "<rootDir>/../../../packages/database/src",
  "^@guestpost/shared/dist/dns-lookup$": "<rootDir>/../../../packages/shared/src/dns-lookup",
  "^@guestpost/shared/dist/delivery-verification-core$": "<rootDir>/../../../packages/shared/src/delivery-verification-core",
  "^@guestpost/shared/dist/object-storage$": "<rootDir>/../../../packages/shared/src/object-storage",
  "^@guestpost/shared/dist/observability/request-context$": "<rootDir>/../../../packages/shared/src/observability/request-context",
  "^@guestpost/shared/dist/observability/structured-logger$": "<rootDir>/../../../packages/shared/src/observability/structured-logger",
  "^@guestpost/shared$": "<rootDir>/../../../packages/shared/src",
  "^@guestpost/auth$": "<rootDir>/../../../packages/auth/src",
  "^better-auth$": "<rootDir>/__mocks__/better-auth",
  "^better-auth/adapters/prisma$": "<rootDir>/__mocks__/better-auth",
  "^better-auth/plugins/bearer$": "<rootDir>/__mocks__/better-auth",
  "^better-auth/node$": "<rootDir>/__mocks__/better-auth",
  "^better-auth/api$": "<rootDir>/__mocks__/better-auth",
}

module.exports = {
  // Root-level: forceExit applies to all projects. See note above.
  forceExit: true,

  projects: [
    {
      displayName: "unit",
      moduleFileExtensions: ["js", "json", "ts"],
      rootDir: "src",
      testRegex: ".*\\.spec\\.ts$",
      testPathIgnorePatterns: ["/node_modules/", "/__tests__/integration/"],
      transform: sharedTransform,
      testEnvironment: "node",
      moduleNameMapper: baseModuleNameMapperFromSrc,
      setupFiles: ["<rootDir>/../jest.setup.js"],
    },
    {
      displayName: "integration",
      moduleFileExtensions: ["js", "json", "ts"],
      // rootDir = apps/api/src/__tests__/integration/
      // - up to apps/api/src/__tests__/  = 1
      // - up to apps/api/src/            = 2
      // - up to apps/api/                = 3
      // - up to apps/                    = 4
      // - up to repo root                = 5
      rootDir: "src/__tests__/integration",
      testRegex: ".*\\.spec\\.ts$",
      transform: sharedTransform,
      testEnvironment: "node",
      moduleNameMapper: {
        ...stripJsMapping,
        "^@guestpost/database$": "<rootDir>/../../../../../packages/database/src",
        "^@guestpost/shared/dist/dns-lookup$": "<rootDir>/../../../../../packages/shared/src/dns-lookup",
        "^@guestpost/shared/dist/delivery-verification-core$": "<rootDir>/../../../../../packages/shared/src/delivery-verification-core",
        "^@guestpost/shared/dist/object-storage$": "<rootDir>/../../../../../packages/shared/src/object-storage",
        "^@guestpost/shared/dist/observability/request-context$": "<rootDir>/../../../../../packages/shared/src/observability/request-context",
        "^@guestpost/shared/dist/observability/structured-logger$": "<rootDir>/../../../../../packages/shared/src/observability/structured-logger",
        "^@guestpost/shared$": "<rootDir>/../../../../../packages/shared/src",
        "^@guestpost/auth$": "<rootDir>/../../../../../packages/auth/src",
        "^better-auth$": "<rootDir>/../../__mocks__/better-auth",
        "^better-auth/adapters/prisma$": "<rootDir>/../../__mocks__/better-auth",
        "^better-auth/plugins/bearer$": "<rootDir>/../../__mocks__/better-auth",
        "^better-auth/node$": "<rootDir>/../../__mocks__/better-auth",
        "^better-auth/api$": "<rootDir>/../../__mocks__/better-auth",
      },
      setupFiles: ["<rootDir>/../../../jest.setup.js"],
      testTimeout: 30_000, // integration specs are slower (DB clone + boot + seed)
    },
  ],
  collectCoverageFrom: ["**/*.(t|j)s"],
  coverageDirectory: "../coverage",
}
