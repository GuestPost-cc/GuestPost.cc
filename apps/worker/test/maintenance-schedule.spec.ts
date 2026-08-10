import assert from "node:assert/strict"
import test from "node:test"
import {
  maintenanceTasksAllowedForFinanceMode,
  maintenanceTasksDueAt,
} from "../src/lib/maintenance-schedule"

const at = (iso: string) => maintenanceTasksDueAt(new Date(iso))

test("dispatches the ten and fifteen minute safety tasks", () => {
  assert.deepEqual(at("2026-07-20T12:00:00Z"), [
    "payment-dispute-inbox",
    "delivery-verification-dispatch",
    "communication-outbox",
    "payout-reconcile",
    "settlement-auto-approve",
    "cancellation-timeouts",
    "settlement-link-check",
  ])
  assert.deepEqual(at("2026-07-20T12:05:00Z"), [
    "payment-dispute-inbox",
    "delivery-verification-dispatch",
    "communication-outbox",
    "settlement-auto-release",
  ])
  assert.deepEqual(at("2026-07-20T12:10:00Z"), [
    "payment-dispute-inbox",
    "delivery-verification-dispatch",
    "communication-outbox",
    "payout-reconcile",
    "acceptance-timeouts",
    "auto-accept",
  ])
})

test("uses the intended five-minute slot when a cold start is delayed", () => {
  assert.deepEqual(at("2026-07-20T12:12:59Z"), [
    "payment-dispute-inbox",
    "delivery-verification-dispatch",
    "communication-outbox",
    "payout-reconcile",
    "acceptance-timeouts",
    "auto-accept",
  ])
})

test("dispatches hourly tasks only in their UTC slot", () => {
  assert.deepEqual(at("2026-07-20T12:20:00Z"), [
    "payment-dispute-inbox",
    "delivery-verification-dispatch",
    "communication-outbox",
    "payout-reconcile",
    "settlement-auto-release",
    "review-reminders",
  ])
  assert.deepEqual(at("2026-07-20T12:30:00Z"), [
    "payment-dispute-inbox",
    "delivery-verification-dispatch",
    "communication-outbox",
    "payout-reconcile",
    "settlement-auto-approve",
    "cancellation-timeouts",
    "reconciliation",
  ])
})

test("dispatches daily verification governance and monthly metric refresh", () => {
  assert.deepEqual(at("2026-08-01T03:00:00Z"), [
    "payment-dispute-inbox",
    "delivery-verification-dispatch",
    "communication-outbox",
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

test("dispatches orphan delivery verification recovery in every five-minute slot", () => {
  for (const minute of [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55]) {
    const iso = `2026-07-20T12:${String(minute).padStart(2, "0")}:00Z`
    assert.equal(at(iso).includes("delivery-verification-dispatch"), true)
  }
})

test("recovery-only runs evidence recovery but blocks liability mutations", () => {
  const due = at("2026-07-20T12:00:00Z")
  assert.deepEqual(
    maintenanceTasksAllowedForFinanceMode(due, "recovery_only"),
    [
      "payment-dispute-inbox",
      "communication-outbox",
      "payout-reconcile",
      "settlement-link-check",
    ],
  )
})

test("locked mode permits only non-financial/read-only scheduled work", () => {
  const due = at("2026-08-01T03:00:00Z")
  assert.deepEqual(maintenanceTasksAllowedForFinanceMode(due, "locked"), [
    "communication-outbox",
    "website-reverify",
    "domain-metrics-refresh",
  ])
})
