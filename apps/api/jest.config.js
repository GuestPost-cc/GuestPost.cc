// Phase 7.10.2 — converted to Jest's projects shape. The unit project preserves
// the fast feedback loop; the integration project uses a dedicated setup file
// with a larger timeout for database clones, locks, and seeded scenarios.
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
  "^@guestpost/shared/dist/dns-lookup$":
    "<rootDir>/../../../packages/shared/src/dns-lookup",
  "^@guestpost/shared/dist/delivery-verification-core$":
    "<rootDir>/../../../packages/shared/src/delivery-verification-core",
  "^@guestpost/shared/dist/development-seed-funding$":
    "<rootDir>/../../../packages/shared/src/development-seed-funding",
  "^@guestpost/shared/dist/development-seed-safety$":
    "<rootDir>/../../../packages/shared/src/development-seed-safety",
  "^@guestpost/shared/dist/object-storage$":
    "<rootDir>/../../../packages/shared/src/object-storage",
  "^@guestpost/shared/dist/payout-finalization-core$":
    "<rootDir>/../../../packages/shared/src/payout-finalization-core",
  "^@guestpost/shared/dist/payout-provider-metadata$":
    "<rootDir>/../../../packages/shared/src/payout-provider-metadata",
  "^@guestpost/shared/dist/payment-dispute-core$":
    "<rootDir>/../../../packages/shared/src/payment-dispute-core",
  "^@guestpost/shared/dist/deposit-credit-core$":
    "<rootDir>/../../../packages/shared/src/deposit-credit-core",
  "^@guestpost/shared/dist/stripe-deposit-recovery$":
    "<rootDir>/../../../packages/shared/src/stripe-deposit-recovery",
  "^@guestpost/shared/dist/prisma-transaction-retry$":
    "<rootDir>/../../../packages/shared/src/prisma-transaction-retry",
  "^@guestpost/shared/dist/observability/request-context$":
    "<rootDir>/../../../packages/shared/src/observability/request-context",
  "^@guestpost/shared/dist/observability/structured-logger$":
    "<rootDir>/../../../packages/shared/src/observability/structured-logger",
  "^@guestpost/shared/dist/publisher-trust-core$":
    "<rootDir>/../../../packages/shared/src/publisher-trust-core",
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
        "^@guestpost/database$":
          "<rootDir>/../../../../../packages/database/src",
        "^@guestpost/shared/dist/dns-lookup$":
          "<rootDir>/../../../../../packages/shared/src/dns-lookup",
        "^@guestpost/shared/dist/delivery-verification-core$":
          "<rootDir>/../../../../../packages/shared/src/delivery-verification-core",
        "^@guestpost/shared/dist/development-seed-funding$":
          "<rootDir>/../../../../../packages/shared/src/development-seed-funding",
        "^@guestpost/shared/dist/development-seed-safety$":
          "<rootDir>/../../../../../packages/shared/src/development-seed-safety",
        "^@guestpost/shared/dist/object-storage$":
          "<rootDir>/../../../../../packages/shared/src/object-storage",
        "^@guestpost/shared/dist/payout-finalization-core$":
          "<rootDir>/../../../../../packages/shared/src/payout-finalization-core",
        "^@guestpost/shared/dist/payout-provider-metadata$":
          "<rootDir>/../../../../../packages/shared/src/payout-provider-metadata",
        "^@guestpost/shared/dist/payment-dispute-core$":
          "<rootDir>/../../../../../packages/shared/src/payment-dispute-core",
        "^@guestpost/shared/dist/deposit-credit-core$":
          "<rootDir>/../../../../../packages/shared/src/deposit-credit-core",
        "^@guestpost/shared/dist/stripe-deposit-recovery$":
          "<rootDir>/../../../../../packages/shared/src/stripe-deposit-recovery",
        "^@guestpost/shared/dist/prisma-transaction-retry$":
          "<rootDir>/../../../../../packages/shared/src/prisma-transaction-retry",
        "^@guestpost/shared/dist/observability/request-context$":
          "<rootDir>/../../../../../packages/shared/src/observability/request-context",
        "^@guestpost/shared/dist/observability/structured-logger$":
          "<rootDir>/../../../../../packages/shared/src/observability/structured-logger",
        "^@guestpost/shared/dist/publisher-trust-core$":
          "<rootDir>/../../../../../packages/shared/src/publisher-trust-core",
        "^@guestpost/shared$": "<rootDir>/../../../../../packages/shared/src",
        "^@guestpost/auth$": "<rootDir>/../../../../../packages/auth/src",
        "^better-auth$": "<rootDir>/../../__mocks__/better-auth",
        "^better-auth/adapters/prisma$":
          "<rootDir>/../../__mocks__/better-auth",
        "^better-auth/plugins/bearer$": "<rootDir>/../../__mocks__/better-auth",
        "^better-auth/node$": "<rootDir>/../../__mocks__/better-auth",
        "^better-auth/api$": "<rootDir>/../../__mocks__/better-auth",
      },
      setupFiles: ["<rootDir>/../../../jest.setup.js"],
      setupFilesAfterEnv: ["<rootDir>/../../../jest.integration.setup.js"],
    },
  ],
  collectCoverageFrom: ["**/*.(t|j)s"],
  coverageDirectory: "../coverage",
}
