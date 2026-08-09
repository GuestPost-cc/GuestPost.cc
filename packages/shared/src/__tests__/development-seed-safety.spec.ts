import {
  assertDevelopmentSeedDatabaseSentinel,
  assertDevelopmentSeedSafety,
  DEVELOPMENT_SEED_DATABASE_SENTINEL,
  isDevelopmentSeedApiRequestAllowed,
} from "../development-seed-safety"

describe("development seed safety boundary", () => {
  it.each([
    ["development", "127.0.0.1"],
    ["test", "::1"],
    ["development", "::ffff:127.0.0.1"],
  ])("allows seed readiness only for %s over loopback %s", (nodeEnv, address) => {
    expect(isDevelopmentSeedApiRequestAllowed(nodeEnv, address)).toBe(true)
  })

  it.each([
    ["production", "127.0.0.1"],
    ["staging", "::1"],
    ["development", "10.0.0.4"],
    ["test", undefined],
  ])("denies seed readiness for %s from %s", (nodeEnv, address) => {
    expect(isDevelopmentSeedApiRequestAllowed(nodeEnv, address)).toBe(false)
  })

  it.each([
    "production",
    "staging",
    "preview",
    undefined,
  ])("rejects NODE_ENV=%s", (nodeEnv) => {
    expect(() =>
      assertDevelopmentSeedSafety(
        nodeEnv,
        "postgresql://user:pass@localhost:5432/guestpost",
        "http://localhost:4000",
      ),
    ).toThrow("explicit development or test")
  })

  it.each([
    "development",
    "test",
  ])("accepts a local PostgreSQL URL in %s", (nodeEnv) => {
    expect(() =>
      assertDevelopmentSeedSafety(
        nodeEnv,
        "postgresql://user:pass@localhost:5432/guestpost",
        "http://localhost:4000",
      ),
    ).not.toThrow()
  })

  it.each([
    "db.example.com",
    "postgres",
  ])("rejects non-loopback database host %s even when NODE_ENV says development", (hostname) => {
    expect(() =>
      assertDevelopmentSeedSafety(
        "development",
        `postgresql://user:pass@${hostname}:5432/guestpost`,
        "http://localhost:4000",
      ),
    ).toThrow("refuses non-local databases")
  })

  it.each([
    "postgresql://user:pass@localhost:6432/guestpost",
    "postgresql://user:pass@localhost:5432/",
    "postgresql://user:pass@localhost:5432/guestpost?host=evil.example.com",
    "postgresql://user:pass@localhost:5432/guestpost#unexpected",
  ])("rejects an indirect or ambiguous local database URL: %s", (databaseUrl) => {
    expect(() =>
      assertDevelopmentSeedSafety(
        "development",
        databaseUrl,
        "http://localhost:4000",
      ),
    ).toThrow("direct loopback PostgreSQL database")
  })

  it.each([
    undefined,
    "not-a-url",
    "https://localhost:5432/guestpost",
  ])("rejects an invalid database target: %s", (databaseUrl) => {
    expect(() =>
      assertDevelopmentSeedSafety(
        "development",
        databaseUrl,
        "http://localhost:4000",
      ),
    ).toThrow()
  })

  it.each([
    "https://localhost:4000",
    "http://localhost:4001",
    "http://postgres:4000",
    "http://api.example.com:4000",
    "http://localhost:4000/api",
  ])("rejects a non-local API target: %s", (apiUrl) => {
    expect(() =>
      assertDevelopmentSeedSafety(
        "development",
        "postgresql://user:pass@localhost:5432/guestpost",
        apiUrl,
      ),
    ).toThrow("refuses non-local APIs")
  })

  it("requires the exact local database sentinel", async () => {
    const valid = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          databaseName: "guestpost",
          databaseOid: "16384",
          systemIdentifier: "7660606137195036706",
          sentinel: DEVELOPMENT_SEED_DATABASE_SENTINEL,
        },
      ]),
    }
    await expect(assertDevelopmentSeedDatabaseSentinel(valid)).resolves.toEqual(
      {
        databaseName: "guestpost",
        databaseOid: "16384",
        systemIdentifier: "7660606137195036706",
      },
    )

    for (const rows of [
      [],
      [
        {
          databaseName: "guestpost",
          databaseOid: "16384",
          systemIdentifier: "7660606137195036706",
          sentinel: null,
        },
      ],
      [
        {
          databaseName: "guestpost",
          databaseOid: "16384",
          systemIdentifier: "7660606137195036706",
          sentinel: "production",
        },
      ],
      [
        {
          databaseName: "guestpost",
          databaseOid: "not-an-oid",
          systemIdentifier: "7660606137195036706",
          sentinel: DEVELOPMENT_SEED_DATABASE_SENTINEL,
        },
      ],
    ]) {
      await expect(
        assertDevelopmentSeedDatabaseSentinel({
          $queryRaw: jest.fn().mockResolvedValue(rows),
        }),
      ).rejects.toThrow("database sentinel is missing")
    }
  })
})
