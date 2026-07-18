import { makeUser } from "../factories"
import { createTestApp } from "../helpers/create-test-app"

describe("[INTEGRATION] Financial — personal wallet creation race", () => {
  it("concurrent reads create exactly one personal wallet", async () => {
    const { app, prisma, cleanup } = await createTestApp()
    try {
      const user = await makeUser(prisma, { userType: "CUSTOMER" })
      const { BillingService } =
        require("../../../modules/billing/billing.service") as any
      const billing: any = app.get(BillingService)

      const results = await Promise.all(
        Array.from({ length: 8 }, () => billing.getWallet(null, user.id)),
      )

      expect(new Set(results.map((wallet: any) => wallet.id)).size).toBe(1)
      await expect(
        prisma.wallet.count({
          where: { userId: user.id, organizationId: null },
        }),
      ).resolves.toBe(1)
    } finally {
      await cleanup()
    }
  }, 30_000)
})
