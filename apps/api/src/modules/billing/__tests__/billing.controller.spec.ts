import { readFileSync } from "node:fs"
import { join } from "node:path"
import { BillingController } from "../billing.controller"

describe("BillingController direct-deposit surface", () => {
  it("does not expose a direct wallet-credit method or route", () => {
    const controller = new BillingController({} as any)
    const source = readFileSync(
      join(__dirname, "..", "billing.controller.ts"),
      "utf8",
    )

    expect((controller as any).deposit).toBeUndefined()
    expect(source).not.toContain('wallet/:id/deposit"')
    expect(source).not.toContain("ENABLE_DIRECT_DEPOSIT")
  })
})
