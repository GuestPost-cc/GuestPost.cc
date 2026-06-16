/** @type {import('jest').Config} */
module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.ts$": "ts-jest",
  },
  collectCoverageFrom: ["**/*.(t|j)s"],
  coverageDirectory: "../coverage",
  testEnvironment: "node",
  moduleNameMapper: {
    "^@guestpost/database$": "<rootDir>/../../../packages/database/src",
    "^@guestpost/shared/dist/dns-lookup$": "<rootDir>/../../../packages/shared/src/dns-lookup",
    "^@guestpost/shared/dist/delivery-verification-core$": "<rootDir>/../../../packages/shared/src/delivery-verification-core",
    "^@guestpost/shared/dist/object-storage$": "<rootDir>/../../../packages/shared/src/object-storage",
    "^@guestpost/shared/dist/observability/request-context$": "<rootDir>/../../../packages/shared/src/observability/request-context",
    "^@guestpost/shared/dist/observability/structured-logger$": "<rootDir>/../../../packages/shared/src/observability/structured-logger",
    "^@guestpost/shared$": "<rootDir>/../../../packages/shared/src",
    "^@guestpost/auth$": "<rootDir>/../../../packages/auth/src",
  },
}
