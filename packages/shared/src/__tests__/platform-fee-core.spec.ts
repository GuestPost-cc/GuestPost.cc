import { resolvePlatformFeeFractionCore } from "../platform-fee-core"

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
})
