import {
  MAINTENANCE_DISPATCH_TASK,
  type MaintenanceTaskName,
} from "./maintenance-schedule"

export const WORKER_MODES = [
  "all",
  "realtime",
  "on-demand",
  "scheduled",
] as const

export type WorkerMode = (typeof WORKER_MODES)[number]

export const WORKER_FACTORY_NAMES = [
  "email",
  "report",
  "notification",
  "verification",
  "payout",
  "reconciliation",
  "website-verification",
  "delivery-verification",
  "publisher-trust",
  "settlement-auto-approve",
  "settlement-release",
  "auto-accept",
  "domain-metrics",
  "integration-discovery",
  "integration-sync",
] as const

export type WorkerFactoryName = (typeof WORKER_FACTORY_NAMES)[number]

export const WORKER_RUNTIME_CAPABILITIES = [
  "connections",
  "object-storage",
  "health-server",
  "legacy-repeatables",
  "remove-hybrid-repeatables",
  "on-demand-drain",
  "scheduled-task",
  "maintenance-dispatch",
] as const

export type WorkerRuntimeCapability =
  (typeof WORKER_RUNTIME_CAPABILITIES)[number]

export const SCHEDULED_TASK_WORKER_FACTORIES = {
  "communication-outbox": "email",
  "payout-reconcile": "payout",
  "payment-dispute-inbox": "reconciliation",
  "deposit-credit-recovery": "reconciliation",
  "delivery-verification-dispatch": "delivery-verification",
  "settlement-auto-approve": "settlement-auto-approve",
  "settlement-auto-release": "settlement-release",
  "cancellation-timeouts": "auto-accept",
  "acceptance-timeouts": "auto-accept",
  "auto-accept": "auto-accept",
  "review-reminders": "auto-accept",
  reconciliation: "reconciliation",
  "settlement-link-check": "delivery-verification",
  "website-reverify": "website-verification",
  "domain-metrics-refresh": "domain-metrics",
} as const satisfies Record<MaintenanceTaskName, WorkerFactoryName>

export type ScheduledTaskName = keyof typeof SCHEDULED_TASK_WORKER_FACTORIES

const ALL_WORKERS = [
  "email",
  "report",
  "notification",
  "verification",
  "payout",
  "reconciliation",
  "website-verification",
  "delivery-verification",
  "publisher-trust",
  "settlement-auto-approve",
  "settlement-release",
  "auto-accept",
  "domain-metrics",
  "integration-discovery",
  "integration-sync",
] as const satisfies readonly WorkerFactoryName[]

const REALTIME_WORKERS = [
  "email",
  "notification",
  "website-verification",
  "delivery-verification",
] as const satisfies readonly WorkerFactoryName[]

const ON_DEMAND_WORKERS = [
  "report",
  "verification",
  "payout",
  "publisher-trust",
  "domain-metrics",
  "integration-discovery",
  "integration-sync",
] as const satisfies readonly WorkerFactoryName[]

const OBJECT_STORAGE_SCHEDULED_TASKS = new Set<ScheduledTaskName>([
  "delivery-verification-dispatch",
  "settlement-link-check",
])

interface RuntimePlanBase {
  mode: WorkerMode
  capabilities: readonly WorkerRuntimeCapability[]
  workerFactories: readonly WorkerFactoryName[]
}

export interface AllWorkerRuntimePlan extends RuntimePlanBase {
  mode: "all"
}

export interface RealtimeWorkerRuntimePlan extends RuntimePlanBase {
  mode: "realtime"
}

export interface OnDemandWorkerRuntimePlan extends RuntimePlanBase {
  mode: "on-demand"
}

export interface ScheduledTaskRuntimePlan extends RuntimePlanBase {
  mode: "scheduled"
  taskName: ScheduledTaskName
  workerFactories: readonly [WorkerFactoryName]
}

export interface MaintenanceDispatchRuntimePlan extends RuntimePlanBase {
  mode: "scheduled"
  taskName: typeof MAINTENANCE_DISPATCH_TASK
  workerFactories: readonly []
}

export type ScheduledWorkerRuntimePlan =
  | ScheduledTaskRuntimePlan
  | MaintenanceDispatchRuntimePlan

export type WorkerRuntimePlan =
  | AllWorkerRuntimePlan
  | RealtimeWorkerRuntimePlan
  | OnDemandWorkerRuntimePlan
  | ScheduledWorkerRuntimePlan

export interface WorkerRuntimeEnvironment {
  WORKER_MODE?: string
  WORKER_TASK?: string
}

function isScheduledTaskName(value: string): value is ScheduledTaskName {
  return Object.hasOwn(SCHEDULED_TASK_WORKER_FACTORIES, value)
}

export function resolveWorkerMode(value: string | undefined): WorkerMode {
  const normalized = (value ?? "all").trim()
  if ((WORKER_MODES as readonly string[]).includes(normalized)) {
    return normalized as WorkerMode
  }
  throw new Error(
    `Invalid WORKER_MODE=${normalized}; expected ${WORKER_MODES.join(", ")}`,
  )
}

export function buildScheduledTaskRuntimePlan(
  taskName: ScheduledTaskName,
): ScheduledTaskRuntimePlan {
  const capabilities: WorkerRuntimeCapability[] = [
    "connections",
    "scheduled-task",
  ]
  if (OBJECT_STORAGE_SCHEDULED_TASKS.has(taskName)) {
    capabilities.splice(1, 0, "object-storage")
  }
  return {
    mode: "scheduled",
    taskName,
    capabilities,
    workerFactories: [SCHEDULED_TASK_WORKER_FACTORIES[taskName]],
  }
}

export function buildWorkerRuntimePlan(
  environment: WorkerRuntimeEnvironment,
): WorkerRuntimePlan {
  const mode = resolveWorkerMode(environment.WORKER_MODE)

  if (mode === "all") {
    return {
      mode,
      capabilities: [
        "connections",
        "object-storage",
        "health-server",
        "legacy-repeatables",
      ],
      workerFactories: ALL_WORKERS,
    }
  }

  if (mode === "realtime") {
    return {
      mode,
      capabilities: [
        "connections",
        "object-storage",
        "remove-hybrid-repeatables",
        "health-server",
      ],
      workerFactories: REALTIME_WORKERS,
    }
  }

  if (mode === "on-demand") {
    return {
      mode,
      capabilities: ["connections", "on-demand-drain"],
      workerFactories: ON_DEMAND_WORKERS,
    }
  }

  const taskName = environment.WORKER_TASK?.trim()
  if (!taskName) {
    throw new Error("WORKER_TASK is required when WORKER_MODE=scheduled")
  }
  if (taskName === MAINTENANCE_DISPATCH_TASK) {
    return {
      mode,
      taskName,
      capabilities: ["connections", "maintenance-dispatch"],
      workerFactories: [],
    }
  }
  if (!isScheduledTaskName(taskName)) {
    throw new Error(`Unknown WORKER_TASK=${taskName}`)
  }
  return buildScheduledTaskRuntimePlan(taskName)
}
