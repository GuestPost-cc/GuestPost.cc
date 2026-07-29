import { NotFoundException } from "@nestjs/common"
import { makeUser } from "../factories"
import { createTestApp } from "../helpers/create-test-app"

describe("[INTEGRATION] Financial — aggregate read purity", () => {
  it("concurrent reads never provision a missing personal wallet", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const user = await makeUser(prisma, { userType: "CUSTOMER" })
      const { BillingService } =
        require("../../../modules/billing/billing.service") as any
      const billing: any = app.get(BillingService)

      const results = await Promise.allSettled(
        Array.from({ length: 8 }, () => billing.getWallet(null, user.id)),
      )

      expect(results).toHaveLength(8)
      expect(
        results.every(
          (result) =>
            result.status === "rejected" &&
            result.reason instanceof NotFoundException,
        ),
      ).toBe(true)
      await expect(
        prisma.wallet.count({
          where: { userId: user.id, organizationId: null },
        }),
      ).resolves.toBe(0)
    } finally {
      await cleanup()
    }
  }, 30_000)
})
