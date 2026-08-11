import assert from "node:assert/strict"
import test from "node:test"
import {
  emailAllowedRecipientDomainsFromEnv,
  emailDeliveryModeFromEnv,
  emailRecipientAllowlistIssueFromEnv,
} from "../src/lib/env"

test("production email delivery fails closed when mode is absent or invalid", () => {
  assert.equal(emailDeliveryModeFromEnv({ NODE_ENV: "production" }), "disabled")
  assert.equal(
    emailDeliveryModeFromEnv({
      NODE_ENV: "production",
      EMAIL_DELIVERY_MODE: "unexpected",
    }),
    "disabled",
  )
})

test("explicit delivery modes are normalized without weakening production", () => {
  assert.equal(
    emailDeliveryModeFromEnv({
      NODE_ENV: "production",
      EMAIL_DELIVERY_MODE: " CAPTURE ",
    }),
    "capture",
  )
  assert.equal(
    emailDeliveryModeFromEnv({
      NODE_ENV: "production",
      EMAIL_DELIVERY_MODE: "live",
    }),
    "live",
  )
})

test("non-production defaults to capture for local mailbox inspection", () => {
  assert.equal(emailDeliveryModeFromEnv({ NODE_ENV: "test" }), "capture")
})

test("recipient-domain allowlists reject delimiter-only and malformed entries", () => {
  assert.deepEqual(
    emailAllowedRecipientDomainsFromEnv({
      EMAIL_ALLOWED_RECIPIENT_DOMAINS: ", ,",
    }),
    { configured: true, domains: [], invalidCount: 0 },
  )
  assert.deepEqual(
    emailAllowedRecipientDomainsFromEnv({
      EMAIL_ALLOWED_RECIPIENT_DOMAINS: "Example.COM, https://unsafe.test",
    }),
    { configured: true, domains: ["example.com"], invalidCount: 1 },
  )
})

test("recipient-domain allowlists normalize and deduplicate exact domains", () => {
  assert.deepEqual(
    emailAllowedRecipientDomainsFromEnv({
      EMAIL_ALLOWED_RECIPIENT_DOMAINS:
        "mail.guestpost.pro.bd,MAIL.GUESTPOST.PRO.BD,example.invalid",
    }),
    {
      configured: true,
      domains: ["mail.guestpost.pro.bd", "example.invalid"],
      invalidCount: 0,
    },
  )
})

test("production capture and configured live allowlists fail closed", () => {
  assert.equal(
    emailRecipientAllowlistIssueFromEnv(
      { EMAIL_ALLOWED_RECIPIENT_DOMAINS: "," },
      "capture",
    ),
    "invalid-or-empty",
  )
  assert.equal(
    emailRecipientAllowlistIssueFromEnv({}, "capture"),
    "capture-required",
  )
  assert.equal(
    emailRecipientAllowlistIssueFromEnv(
      { EMAIL_ALLOWED_RECIPIENT_DOMAINS: "good.test,https://bad.test" },
      "live",
    ),
    "invalid-or-empty",
  )
  assert.equal(emailRecipientAllowlistIssueFromEnv({}, "live"), null)
  assert.equal(
    emailRecipientAllowlistIssueFromEnv(
      { EMAIL_ALLOWED_RECIPIENT_DOMAINS: "," },
      "disabled",
    ),
    null,
  )
})
