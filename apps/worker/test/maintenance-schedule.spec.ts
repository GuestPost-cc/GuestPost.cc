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

test("uses the intended five-minute slot when a cold start is delayed", () => {
  assert.deepEqual(at("2026-07-20T12:12:59Z"), [
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

test("dispatches daily verification governance and monthly metric refresh", () => {
  assert.deepEqual(at("2026-08-01T03:00:00Z"), [
    "payout-reconcile",
    "settlement-auto-approve",
    "cancellation-timeouts",
    "website-reverify",
    "domain-metrics-refresh",
  ])
  assert.equal(at("2026-08-02T03:00:00Z").includes("website-reverify"), true)
  assert.equal(
    at("2026-08-02T03:00:00Z").includes("domain-metrics-refresh"),
    false,
  )
})

test("rejects invalid timestamps", () => {
  assert.throws(
    () => maintenanceTasksDueAt(new Date("invalid")),
    /valid dispatch timestamp/,
  )
})
