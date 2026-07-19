import assert from "node:assert/strict"
import test from "node:test"
import { maintenanceTasksDueAt } from "../src/lib/maintenance-schedule"

const at = (iso: string) => maintenanceTasksDueAt(new Date(iso))

test("dispatches the ten and fifteen minute safety tasks", () => {
  assert.deepEqual(at("2026-07-20T12:00:00Z"), [
    "payout-reconcile",
    "settlement-auto-approve",
    "cancellation-timeouts",
    "settlement-link-check",
  ])
  assert.deepEqual(at("2026-07-20T12:05:00Z"), ["settlement-auto-release"])
  assert.deepEqual(at("2026-07-20T12:10:00Z"), [
    "payout-reconcile",
    "acceptance-timeouts",
    "auto-accept",
  ])
})

test("dispatches hourly tasks only in their UTC slot", () => {
  assert.deepEqual(at("2026-07-20T12:20:00Z"), [
    "payout-reconcile",
    "settlement-auto-release",
    "review-reminders",
  ])
  assert.deepEqual(at("2026-07-20T12:30:00Z"), [
    "payout-reconcile",
    "settlement-auto-approve",
    "cancellation-timeouts",
    "reconciliation",
  ])
})

test("dispatches monthly verification only on the first day at 03:00 UTC", () => {
  assert.deepEqual(at("2026-08-01T03:00:00Z"), [
    "payout-reconcile",
    "settlement-auto-approve",
    "cancellation-timeouts",
    "website-reverify",
  ])
  assert.equal(at("2026-08-02T03:00:00Z").includes("website-reverify"), false)
})

test("rejects invalid timestamps", () => {
  assert.throws(
    () => maintenanceTasksDueAt(new Date("invalid")),
    /valid dispatch timestamp/,
  )
})
