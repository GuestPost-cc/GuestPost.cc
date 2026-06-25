/**
 * Publisher journey: signup → automatic become-publisher conversion →
 * publisher dashboard with listings/withdrawals nav.
 */
import { expect, test } from "@playwright/test"

const PUBLISHER = process.env.E2E_PUBLISHER_URL ?? "http://localhost:3002"

test("publisher can sign up and land in the publisher dashboard as a converted account", async ({
  page,
}) => {
  const email = `e2e-pub-${Date.now()}@test.local`

  await page.goto(PUBLISHER)
  await page.getByRole("button", { name: "Sign up" }).click()
  await page.getByPlaceholder("Full name").fill("E2E Publisher")
  await page.getByPlaceholder("Email").fill(email)
  await page.getByPlaceholder("Password").fill("E2EPublisher123!")
  await page.getByRole("button", { name: "Create Account" }).click()

  // Conversion happened during signup — the publisher shell renders
  await expect(page.getByRole("link", { name: "Listings" })).toBeVisible({
    timeout: 20_000,
  })
  await expect(page.getByRole("link", { name: "Withdrawals" })).toBeVisible()

  // Listings page loads with its empty state (a publisher entity exists —
  // otherwise this API call would 403/500)
  await page.goto(`${PUBLISHER}/dashboard/listings`)
  await expect(page.getByText(/no listings yet/i)).toBeVisible({
    timeout: 15_000,
  })
})
