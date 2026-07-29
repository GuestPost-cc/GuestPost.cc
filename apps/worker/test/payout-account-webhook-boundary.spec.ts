import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const payoutProcessorSource = readFileSync(
  new URL("../src/processors/payout.processor.ts", import.meta.url),
  "utf8",
)

test("generic payout completion inbox never consumes Stripe account routing events", () => {
  assert.match(
    payoutProcessorSource,
    /NOT:\s*\{\s*provider:\s*"stripe_connect",\s*eventType:\s*"account\.updated",\s*\}/s,
  )
})
