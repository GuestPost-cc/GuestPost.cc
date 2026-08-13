import assert from "node:assert/strict"
import { EventEmitter, once } from "node:events"
import test from "node:test"
import {
  createWorkerRuntime,
  installWorkerSignalHandlers,
  type WorkerFactoryRegistry,
  type WorkerRuntimeDependencies,
} from "../src/lib/worker-runtime"
import {
  buildWorkerRuntimePlan,
  SCHEDULED_TASK_WORKER_FACTORIES,
  type WorkerFactoryName,
} from "../src/lib/worker-runtime-plan"

const ALL_FACTORIES = [
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

const EXPECTED_SCHEDULED_FACTORIES = {
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
} as const

function createFixture(failFactory?: WorkerFactoryName): {
  dependencies: WorkerRuntimeDependencies
  events: string[]
} {
  const events: string[] = []
  const workerFactories = Object.fromEntries(
    ALL_FACTORIES.map((name) => [
      name,
      async () => {
        events.push(`create:${name}`)
        if (name === failFactory) {
          throw new Error(`factory failed:${name}`)
        }
        return {
          close: async () => {
            events.push(`close:${name}`)
          },
        }
      },
    ]),
  ) as WorkerFactoryRegistry

  return {
    events,
    dependencies: {
      workerFactories,
      checkConnections: async () => {
        events.push("connections")
      },
      assertObjectStorageReadiness: async () => {
        events.push("object-storage")
      },
      startHealthServer: async () => {
        events.push("health-server")
        return {
          close: async () => {
            events.push("close:health-server")
          },
        }
      },
      removeHybridRepeatables: async () => {
        events.push("remove-hybrid-repeatables")
      },
      registerLegacyRepeatables: async () => {
        events.push("legacy-repeatables")
      },
      drainOnDemandQueues: async () => {
        events.push("on-demand-drain")
      },
      runScheduledTask: async (plan) => {
        events.push(
          `scheduled:${plan.taskName}:${plan.workerFactories.join(",")}`,
        )
      },
      runMaintenanceDispatch: async () => {
        events.push("maintenance-dispatch")
      },
      closeRedis: async () => {
        events.push("close:redis")
      },
      disconnectDatabase: async () => {
        events.push("close:database")
      },
      flushTelemetry: async () => {
        events.push("close:telemetry")
      },
    },
  }
}

test("builds exact all, realtime, and on-demand runtime plans", () => {
  assert.deepEqual(buildWorkerRuntimePlan({ WORKER_MODE: "all" }), {
    mode: "all",
    capabilities: [
      "connections",
      "object-storage",
      "health-server",
      "legacy-repeatables",
    ],
    workerFactories: ALL_FACTORIES,
  })
  assert.deepEqual(buildWorkerRuntimePlan({ WORKER_MODE: "realtime" }), {
    mode: "realtime",
    capabilities: [
      "connections",
      "object-storage",
      "remove-hybrid-repeatables",
      "health-server",
    ],
    workerFactories: [
      "email",
      "notification",
      "website-verification",
      "delivery-verification",
    ],
  })
  assert.deepEqual(buildWorkerRuntimePlan({ WORKER_MODE: "on-demand" }), {
    mode: "on-demand",
    capabilities: ["connections", "on-demand-drain"],
    workerFactories: [
      "report",
      "verification",
      "payout",
      "publisher-trust",
      "domain-metrics",
      "integration-discovery",
      "integration-sync",
    ],
  })
})

test("maps every scheduled task to its exact factory and capabilities", () => {
  assert.deepEqual(
    SCHEDULED_TASK_WORKER_FACTORIES,
    EXPECTED_SCHEDULED_FACTORIES,
  )
  for (const [taskName, workerFactory] of Object.entries(
    EXPECTED_SCHEDULED_FACTORIES,
  )) {
    const plan = buildWorkerRuntimePlan({
      WORKER_MODE: "scheduled",
      WORKER_TASK: taskName,
    })
    assert.equal(plan.mode, "scheduled")
    assert.deepEqual(plan.workerFactories, [workerFactory], taskName)
    assert.deepEqual(
      plan.capabilities,
      [
        "connections",
        ...([
          "delivery-verification-dispatch",
          "settlement-link-check",
        ].includes(taskName)
          ? ["object-storage"]
          : []),
        "scheduled-task",
      ],
      taskName,
    )
  }

  assert.deepEqual(
    buildWorkerRuntimePlan({
      WORKER_MODE: "scheduled",
      WORKER_TASK: "maintenance-dispatch",
    }),
    {
      mode: "scheduled",
      taskName: "maintenance-dispatch",
      capabilities: ["connections", "maintenance-dispatch"],
      workerFactories: [],
    },
  )
})

test("invalid modes and tasks fail before any runtime dependency runs", async () => {
  const { dependencies, events } = createFixture()
  const runtime = createWorkerRuntime(dependencies)

  await assert.rejects(
    runtime.bootstrap({ WORKER_MODE: "everything" }),
    /Invalid WORKER_MODE=everything/,
  )
  assert.deepEqual(events, [])

  assert.throws(
    () =>
      buildWorkerRuntimePlan({
        WORKER_MODE: "scheduled",
        WORKER_TASK: "unknown",
      }),
    /Unknown WORKER_TASK=unknown/,
  )
  assert.throws(
    () => buildWorkerRuntimePlan({ WORKER_MODE: "scheduled" }),
    /WORKER_TASK is required/,
  )
})

test("behaviorally boots all and realtime with only their planned capabilities", async () => {
  const allFixture = createFixture()
  const all = createWorkerRuntime(allFixture.dependencies)
  const allOutcome = await all.bootstrap({ WORKER_MODE: "all" })
  assert.equal(allOutcome.disposition, "running")
  assert.deepEqual(allFixture.events, [
    "connections",
    "object-storage",
    "health-server",
    ...ALL_FACTORIES.map((name) => `create:${name}`),
    "legacy-repeatables",
  ])
  await all.shutdown("test-complete")

  const realtimeFixture = createFixture()
  const realtime = createWorkerRuntime(realtimeFixture.dependencies)
  const realtimeOutcome = await realtime.bootstrap({ WORKER_MODE: "realtime" })
  assert.equal(realtimeOutcome.disposition, "running")
  assert.deepEqual(realtimeFixture.events, [
    "connections",
    "object-storage",
    "remove-hybrid-repeatables",
    "health-server",
    "create:email",
    "create:notification",
    "create:website-verification",
    "create:delivery-verification",
  ])
  await realtime.shutdown("test-complete")
})

test("on-demand and scheduled modes complete and clean up deterministically", async () => {
  const onDemandFixture = createFixture()
  const onDemand = createWorkerRuntime(onDemandFixture.dependencies)
  const onDemandOutcome = await onDemand.bootstrap({
    WORKER_MODE: "on-demand",
  })
  assert.equal(onDemandOutcome.disposition, "completed")
  assert.deepEqual(onDemandFixture.events, [
    "connections",
    "create:report",
    "create:verification",
    "create:payout",
    "create:publisher-trust",
    "create:domain-metrics",
    "create:integration-discovery",
    "create:integration-sync",
    "on-demand-drain",
    "close:integration-sync",
    "close:integration-discovery",
    "close:domain-metrics",
    "close:publisher-trust",
    "close:payout",
    "close:verification",
    "close:report",
    "close:redis",
    "close:database",
    "close:telemetry",
  ])

  const scheduledFixture = createFixture()
  const scheduled = createWorkerRuntime(scheduledFixture.dependencies)
  const scheduledOutcome = await scheduled.bootstrap({
    WORKER_MODE: "scheduled",
    WORKER_TASK: "settlement-link-check",
  })
  assert.equal(scheduledOutcome.disposition, "completed")
  assert.deepEqual(scheduledFixture.events, [
    "connections",
    "object-storage",
    "scheduled:settlement-link-check:delivery-verification",
    "close:redis",
    "close:database",
    "close:telemetry",
  ])

  const dispatchFixture = createFixture()
  const dispatch = createWorkerRuntime(dispatchFixture.dependencies)
  await dispatch.bootstrap({
    WORKER_MODE: "scheduled",
    WORKER_TASK: "maintenance-dispatch",
  })
  assert.deepEqual(dispatchFixture.events, [
    "connections",
    "maintenance-dispatch",
    "close:redis",
    "close:database",
    "close:telemetry",
  ])
})

test("a factory failure propagates unchanged after partial construction cleanup", async () => {
  const { dependencies, events } = createFixture("notification")
  const runtime = createWorkerRuntime(dependencies)

  await assert.rejects(
    runtime.bootstrap({ WORKER_MODE: "realtime" }),
    (error: unknown) => {
      assert.equal((error as Error).message, "factory failed:notification")
      return true
    },
  )
  assert.deepEqual(events, [
    "connections",
    "object-storage",
    "remove-hybrid-repeatables",
    "health-server",
    "create:email",
    "create:notification",
    "close:email",
    "close:health-server",
    "close:redis",
    "close:database",
    "close:telemetry",
  ])
})

test("SIGTERM drains the runtime once and closes every owned resource", async () => {
  const { dependencies, events } = createFixture()
  const runtime = createWorkerRuntime(dependencies)
  await runtime.bootstrap({ WORKER_MODE: "realtime" })

  const target = new EventEmitter()
  const completed = new EventEmitter()
  const uninstall = installWorkerSignalHandlers(runtime, target, {
    onShutdownComplete: (signal) => completed.emit("complete", signal),
    onShutdownError: (error) => completed.emit("error", error),
  })

  target.emit("SIGTERM")
  target.emit("SIGINT")
  const [signal] = await once(completed, "complete")
  assert.equal(signal, "SIGTERM")
  assert.deepEqual(events.slice(-8), [
    "close:delivery-verification",
    "close:website-verification",
    "close:notification",
    "close:email",
    "close:health-server",
    "close:redis",
    "close:database",
    "close:telemetry",
  ])

  uninstall()
  assert.equal(target.listenerCount("SIGTERM"), 0)
  assert.equal(target.listenerCount("SIGINT"), 0)
  await runtime.shutdown("second-call")
  assert.equal(events.filter((event) => event === "close:redis").length, 1)
})
