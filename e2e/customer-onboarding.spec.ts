/**
 * Customer journey: signup → org-creation gate → dashboard with wallet.
 * Creates a throwaway account per run — no seed coupling.
 */
import { test, expect } from "@playwright/test"

const PORTAL = process.env.E2E_PORTAL_URL ?? "http://localhost:3001"

test("customer can sign up, create an organization, and reach a funded-ready dashboard", async ({ page }) => {
  const email = `e2e-cust-${Date.now()}@test.local`

  await page.goto(PORTAL)
  await page.getByRole("button", { name: "Sign up" }).click()
  await page.getByPlaceholder("Full name").fill("E2E Customer")
  await page.getByPlaceholder("Email").fill(email)
  await page.getByPlaceholder("Password").fill("E2ECustomer123!")
  await page.getByRole("button", { name: "Create Account" }).click()

  // Fresh customers hit the org-creation gate before any dashboard content
  await expect(page.getByText("Create your organization")).toBeVisible({ timeout: 20_000 })
  await page.getByLabel("Organization name").fill("E2E Test Org")
  await page.getByRole("button", { name: "Create organization" }).click()

  // Gate clears into the real dashboard shell
  await expect(page.getByRole("link", { name: "Campaigns" })).toBeVisible({ timeout: 20_000 })

  // Money actions are reachable: billing page renders the wallet (not a 403 error state)
  await page.goto(`${PORTAL}/dashboard/billing`)
  await expect(page.getByText(/available balance/i).first()).toBeVisible({ timeout: 15_000 })
})
