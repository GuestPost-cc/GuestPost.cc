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
    "^@guestpost/shared$": "<rootDir>/../../../packages/shared/src",
    "^@guestpost/auth$": "<rootDir>/../../../packages/auth/src",
  },
}
