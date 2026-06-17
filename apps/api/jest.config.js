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
  testPathIgnorePatterns: ["/node_modules/"],
  // CI hang protection — without this, jest waits indefinitely for
  // open handles to close (Redis sockets, BullMQ connections, etc).
  // Locally the worker-process auto-timeout eventually force-exits
  // after ~60s; CI runners give up much later or not at all. Phase
  // 7.8 PR #5 stalled on this for 40+ min before being cancelled.
  // Tracking down individual leaks is a separate cleanup pass —
  // `--detectOpenHandles` exposes them when you want to chase them.
  forceExit: true,
}
