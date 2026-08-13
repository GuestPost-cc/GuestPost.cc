/**
 * Customer journey: signup → authenticated org gate → verification policy.
 * Creates a run-scoped throwaway account — no privileged seed coupling.
 */
import { expect, test } from "@playwright/test"
import { fixtureEmail } from "./support/fixture-identity"

test("customer signup reaches the organization gate and enforces email verification", async ({
  page,
}, testInfo) => {
  const email = fixtureEmail(testInfo, "customer")

  await page.goto("/signup")
  await page.getByRole("checkbox", { name: /Terms of Service/ }).check()
  await page.getByLabel("Full name").fill("E2E Customer")
  await page.getByLabel("Email address").fill(email)
  await page.getByLabel("Password", { exact: true }).fill("E2ECustomer123!")
  await page.getByRole("button", { name: "Create customer account" }).click()

  // Fresh customers hit the org-creation gate before any dashboard content
  await expect(page.getByText("Create your organization")).toBeVisible({
    timeout: 20_000,
  })

  // A new account is intentionally unverified. Prove the real authorization
  // boundary rather than bypassing it with a privileged seed: organization
  // creation is a mutation and must remain blocked until email verification.
  await page.getByLabel("Organization name").fill("E2E Test Organization")
  const createResponse = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().endsWith("/api/v1/identity/organizations"),
  )
  await page.getByRole("button", { name: "Create organization" }).click()
  const response = await createResponse
  expect(response.status()).toBe(403)
  expect(JSON.stringify(await response.json())).toContain("EMAIL_NOT_VERIFIED")
  await expect(page.getByText("Create your organization")).toBeVisible()
})
