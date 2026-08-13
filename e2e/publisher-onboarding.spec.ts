/**
 * Publisher journey: signup → birth-time PUBLISHER provisioning →
 * publisher dashboard with listings/withdrawals nav.
 *
 * Phase 7.11 — userType is now set at signup time via the databaseHooks in
 * packages/auth (x-portal-type=publisher). The old become-publisher
 * conversion step is no longer part of the signup flow.
 */
import { expect, test } from "@playwright/test"
import { fixtureEmail } from "./support/fixture-identity"

test("publisher signup provisions an account and opens the publisher workspace", async ({
  page,
}, testInfo) => {
  const email = fixtureEmail(testInfo, "publisher")

  await page.goto("/signup")
  await page.getByRole("checkbox", { name: /Terms of Service/ }).check()
  await page.getByLabel("Full name").fill("E2E Publisher")
  await page.getByLabel("Email address").fill(email)
  await page.getByLabel("Password").fill("E2EPublisher123!")
  await page.getByRole("button", { name: "Create publisher account" }).click()

  // Birth-time provisioning happened during signup — the publisher shell renders.
  const navigation = page.getByRole("navigation", {
    name: "Publisher navigation",
  })
  await expect(navigation.getByRole("link", { name: "Listings" })).toBeVisible({
    timeout: 20_000,
  })
  await expect(
    navigation.getByRole("link", { name: "Withdrawals" }),
  ).toBeVisible()

  // Listings loads its true empty state. A missing publisher projection would
  // instead make this request fail authorization.
  await page.goto("/dashboard/listings")
  await expect(
    page.getByRole("heading", { name: "No listings match" }),
  ).toBeVisible({
    timeout: 15_000,
  })
  await expect(page.getByRole("link", { name: "Enlist website" })).toBeVisible()
})
