import {
  type FinanceOperationKind,
  type FinanceRuntimeMode,
  isFinanceOperationAllowed,
} from "@guestpost/shared"

export const MAINTENANCE_DISPATCH_TASK = "maintenance-dispatch"

export const MAINTENANCE_TASK_NAMES = [
  "payout-reconcile",
  "payment-dispute-inbox",
  "delivery-verification-dispatch",
  "settlement-auto-approve",
  "settlement-auto-release",
  "cancellation-timeouts",
  "acceptance-timeouts",
  "auto-accept",
  "review-reminders",
  "reconciliation",
  "settlement-link-check",
  "website-reverify",
  "domain-metrics-refresh",
] as const

export type MaintenanceTaskName = (typeof MAINTENANCE_TASK_NAMES)[number]

const MAINTENANCE_FINANCE_OPERATION: Record<
  MaintenanceTaskName,
  FinanceOperationKind
> = {
  "payout-reconcile": "recovery",
  "payment-dispute-inbox": "recovery",
  "delivery-verification-dispatch": "new_liability",
  "settlement-auto-approve": "operator_decision",
  "settlement-auto-release": "new_liability",
  "cancellation-timeouts": "operator_decision",
  "acceptance-timeouts": "operator_decision",
  "auto-accept": "operator_decision",
  "review-reminders": "read",
  reconciliation: "reconciliation",
  "settlement-link-check": "reconciliation",
  "website-reverify": "read",
  "domain-metrics-refresh": "read",
}

export function maintenanceTasksAllowedForFinanceMode(
  tasks: readonly MaintenanceTaskName[],
  mode: FinanceRuntimeMode,
): MaintenanceTaskName[] {
  return tasks.filter((task) =>
    isFinanceOperationAllowed(mode, MAINTENANCE_FINANCE_OPERATION[task]),
  )
}

/**
 * Resolve the maintenance tasks due in the current five-minute UTC slot.
 *
 * Northflank free projects allow only two jobs. Production therefore uses one
 * five-minute dispatcher job instead of one cron job per task. This function
 * is intentionally pure so cadence changes remain deterministic and testable.
 */
export function maintenanceTasksDueAt(now: Date): MaintenanceTaskName[] {
  if (Number.isNaN(now.getTime())) {
    throw new Error("A valid dispatch timestamp is required")
  }

  // A cold start may begin after the nominal cron minute. Resolve against the
  // current five-minute slot so a delayed 12:10 run does not become a no-op at
  // 12:11. BullMQ task IDs still prevent a duplicate run in the same slot.
  const slot = new Date(Math.floor(now.getTime() / 300_000) * 300_000)
  const minute = slot.getUTCMinutes()
  const hour = slot.getUTCHours()
  const day = slot.getUTCDate()
  const tasks: MaintenanceTaskName[] = []

  // A failed opening event leaves disputed funds spendable until its hold is
  // applied. Drain every dispatcher slot (five minutes).
  tasks.push("payment-dispute-inbox")
  // Recover delivery rows committed while Redis was unavailable. The sweep
  // itself is bounded and deterministic, so every dispatcher slot is safe.
  tasks.push("delivery-verification-dispatch")
  if (minute % 10 === 0) tasks.push("payout-reconcile")
  if (minute % 15 === 0) {
    tasks.push("settlement-auto-approve", "cancellation-timeouts")
  }
  if (minute % 15 === 5) tasks.push("settlement-auto-release")

  // The former 7/22/37/52 cadence is rounded up to the next five-minute slot.
  // Deadlines run at most three minutes later while avoiding a 1-minute cron.
  if (minute % 15 === 10) tasks.push("acceptance-timeouts")

  if (minute === 10) tasks.push("auto-accept")
  if (minute === 20) tasks.push("review-reminders")
  if (minute === 30) tasks.push("reconciliation")
  if (minute === 0 && hour % 6 === 0) tasks.push("settlement-link-check")
  if (minute === 0 && hour === 3) tasks.push("website-reverify")
  if (minute === 0 && hour === 3 && day === 1)
    tasks.push("domain-metrics-refresh")

  return tasks
}
