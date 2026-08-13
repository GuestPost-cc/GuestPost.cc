/**
 * Customer journey: signup → authenticated org gate → verification policy.
 * Creates a run-scoped throwaway account — no privileged seed coupling.
 */
import { expect, test } from "@playwright/test"
import { fixtureEmail } from "./support/fixture-identity"

test("customer signup provisions a workspace and enforces email verification", async ({
  page,
}, testInfo) => {
  const email = fixtureEmail(testInfo, "customer")

  await page.goto("/signup")
  await page.getByRole("checkbox", { name: /Terms of Service/ }).check()
  await page.getByLabel("Full name").fill("E2E Customer")
  await page.getByLabel("Email address").fill(email)
  await page.getByLabel("Password", { exact: true }).fill("E2ECustomer123!")
  await page.getByRole("button", { name: "Create customer account" }).click()

  // Birth-time provisioning must attach an active organization before the
  // customer shell renders. A missing projection would show the creation gate.
  const navigation = page.getByRole("navigation", {
    name: "Customer navigation",
  })
  await expect(
    navigation.getByRole("link", { name: "Work Queue" }),
  ).toBeVisible({ timeout: 20_000 })

  // A new account is intentionally unverified. Exercise the real browser
  // session, CORS and CSRF path and prove a state-changing command remains
  // blocked without creating a privileged test bypass.
  const mutation = await page.evaluate(async () => {
    const response = await fetch(
      "http://localhost:4000/api/v1/identity/organizations",
      {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "x-csrf-protection": "1",
        },
        body: JSON.stringify({
          name: "E2E Unverified Organization",
          slug: "e2e-unverified-organization",
        }),
      },
    )
    return { status: response.status, body: await response.text() }
  })
  expect(mutation.status).toBe(403)
  expect(mutation.body).toContain("EMAIL_NOT_VERIFIED")
})
