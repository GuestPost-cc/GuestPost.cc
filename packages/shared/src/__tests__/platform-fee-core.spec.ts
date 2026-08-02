import {
  platformFeePercentToBasisPoints,
  resolvePlatformFeeFractionCore,
  resolvePlatformFeePolicyCore,
} from "../platform-fee-core"

describe("platform fee resolution", () => {
  it("uses the database setting ahead of the environment", async () => {
    const prisma = {
      platformSettings: {
        findFirst: jest.fn().mockResolvedValue({ platformFeePct: 17.5 }),
      },
    }

    await expect(resolvePlatformFeeFractionCore(prisma, "25")).resolves.toBe(
      0.175,
    )
  })

  it("falls back safely and clamps the percentage", async () => {
    const prisma = {
      platformSettings: {
        findFirst: jest.fn().mockRejectedValue(new Error("not migrated")),
      },
    }

    await expect(resolvePlatformFeeFractionCore(prisma, "150")).resolves.toBe(1)
    await expect(
      resolvePlatformFeeFractionCore(prisma, "not-a-number"),
    ).resolves.toBe(0.2)
  })

  it("resolves a versioned integer-basis-point policy snapshot", async () => {
    const prisma = {
      platformSettings: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: "settings-1",
            platformFeePct: "17.25",
            version: 4,
          },
        ]),
      },
    }

    await expect(resolvePlatformFeePolicyCore(prisma)).resolves.toEqual({
      basisPoints: 1725,
      fraction: 0.1725,
      policyVersion: "platform-settings:settings-1:v4",
      settingsId: "settings-1",
      settingsVersion: 4,
    })
  })

  it("fails closed without one versioned settings row", async () => {
    await expect(
      resolvePlatformFeePolicyCore({
        platformSettings: { findMany: jest.fn().mockResolvedValue([]) },
      }),
    ).rejects.toThrow(/Versioned PlatformSettings policy is unavailable/)
  })

  it("fails closed when more than one policy row exists", async () => {
    await expect(
      resolvePlatformFeePolicyCore({
        platformSettings: {
          findMany: jest.fn().mockResolvedValue([
            { id: "settings-1", platformFeePct: "20", version: 1 },
            { id: "settings-2", platformFeePct: "20", version: 1 },
          ]),
        },
      }),
    ).rejects.toThrow(/Versioned PlatformSettings policy is unavailable/)
  })

  it.each([
    [{ id: "", platformFeePct: "20", version: 1 }, /unavailable/],
    [{ id: "settings-1", platformFeePct: "20", version: 0 }, /unavailable/],
    [
      { id: "settings-1", platformFeePct: "20.001", version: 1 },
      /at most two decimals/,
    ],
    [
      { id: "x".repeat(120), platformFeePct: "20", version: 1 },
      /identity is invalid/,
    ],
  ])("rejects malformed versioned policy evidence %#", async (row, error) => {
    await expect(
      resolvePlatformFeePolicyCore({
        platformSettings: { findMany: jest.fn().mockResolvedValue([row]) },
      }),
    ).rejects.toThrow(error)
  })

  it.each([
    ["0", 0],
    ["17.5", 1750],
    ["100.00", 10_000],
  ])("parses %s percent as %i basis points", (percent, expected) => {
    expect(platformFeePercentToBasisPoints(percent)).toBe(expected)
  })

  it.each([
    "-1",
    "10.001",
    "100.01",
    "usd",
    " 20 ",
  ])("rejects non-canonical fee percentage %s", (percent) => {
    expect(() => platformFeePercentToBasisPoints(percent)).toThrow()
  })
})
