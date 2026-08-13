import {
  buildWorkerRuntimePlan,
  type ScheduledTaskRuntimePlan,
  type WorkerFactoryName,
  type WorkerRuntimeEnvironment,
  type WorkerRuntimePlan,
} from "./worker-runtime-plan"

export interface WorkerHandle {
  close(): Promise<void>
}

export type WorkerFactory = () => WorkerHandle | Promise<WorkerHandle>

export type WorkerFactoryRegistry = Record<WorkerFactoryName, WorkerFactory>

export interface WorkerRuntimeLogger {
  info(message: string, context?: Record<string, unknown>): void
  error(message: string, context?: Record<string, unknown>): void
}

const NOOP_LOGGER: WorkerRuntimeLogger = {
  info: () => undefined,
  error: () => undefined,
}

export interface WorkerRuntimeDependencies {
  workerFactories: WorkerFactoryRegistry
  checkConnections(): Promise<void>
  assertObjectStorageReadiness(): Promise<void>
  startHealthServer(): Promise<WorkerHandle>
  removeHybridRepeatables(): Promise<void>
  registerLegacyRepeatables(): Promise<void>
  drainOnDemandQueues(): Promise<void>
  runScheduledTask(plan: ScheduledTaskRuntimePlan): Promise<void>
  runMaintenanceDispatch(): Promise<void>
  closeRedis(): Promise<void>
  disconnectDatabase(): Promise<void>
  flushTelemetry(): Promise<void>
  logger?: WorkerRuntimeLogger
}

export interface WorkerRuntimeOutcome {
  disposition: "running" | "completed"
  plan: WorkerRuntimePlan
}

export interface WorkerRuntime {
  bootstrap(
    environment: WorkerRuntimeEnvironment,
  ): Promise<WorkerRuntimeOutcome>
  shutdown(reason: string): Promise<void>
}

function hasCapability(
  plan: WorkerRuntimePlan,
  capability: WorkerRuntimePlan["capabilities"][number],
): boolean {
  return plan.capabilities.includes(capability)
}

export function createWorkerRuntime(
  dependencies: WorkerRuntimeDependencies,
): WorkerRuntime {
  const logger = dependencies.logger ?? NOOP_LOGGER
  const workers: WorkerHandle[] = []
  let healthServer: WorkerHandle | undefined
  let lifecycle: "new" | "bootstrapping" | "running" | "stopping" | "closed" =
    "new"
  let cleanupPromise: Promise<void> | undefined

  async function startHealthServer(): Promise<void> {
    const handle = await dependencies.startHealthServer()
    if (cleanupPromise) {
      await handle.close()
      throw new Error("Worker runtime stopped while health server was starting")
    }
    healthServer = handle
  }

  async function startWorkers(
    factoryNames: readonly WorkerFactoryName[],
  ): Promise<void> {
    for (const factoryName of factoryNames) {
      const handle = await dependencies.workerFactories[factoryName]()
      if (cleanupPromise) {
        await handle.close()
        throw new Error(
          `Worker runtime stopped while ${factoryName} was starting`,
        )
      }
      workers.push(handle)
    }
  }

  function cleanup(reason: string): Promise<void> {
    if (cleanupPromise) return cleanupPromise
    lifecycle = "stopping"
    cleanupPromise = (async () => {
      logger.info("worker runtime draining", { reason })
      const errors: Error[] = []
      const attempt = async (
        resource: string,
        closeResource: () => Promise<void>,
      ): Promise<void> => {
        try {
          await closeResource()
        } catch (error) {
          const normalized =
            error instanceof Error ? error : new Error(String(error))
          errors.push(normalized)
          logger.error("worker runtime cleanup failed", {
            resource,
            err: normalized.message,
          })
        }
      }

      for (const [index, worker] of [...workers].reverse().entries()) {
        await attempt(`worker:${workers.length - index - 1}`, () =>
          worker.close(),
        )
      }
      workers.length = 0

      if (healthServer) {
        const server = healthServer
        healthServer = undefined
        await attempt("health-server", () => server.close())
      }
      await attempt("redis", dependencies.closeRedis)
      await attempt("database", dependencies.disconnectDatabase)
      await attempt("telemetry", dependencies.flushTelemetry)

      lifecycle = "closed"
      logger.info("worker runtime shutdown complete", { reason })
      if (errors.length > 0) {
        throw new AggregateError(
          errors,
          `Worker runtime cleanup failed for ${errors.length} resource(s)`,
        )
      }
    })()
    return cleanupPromise
  }

  async function bootstrap(
    environment: WorkerRuntimeEnvironment,
  ): Promise<WorkerRuntimeOutcome> {
    if (lifecycle !== "new") {
      throw new Error(`Worker runtime cannot bootstrap from state ${lifecycle}`)
    }

    // Resolve the complete plan before touching Redis, Postgres, storage, or
    // any worker factory. Invalid deployment configuration therefore fails
    // without runtime side effects.
    const plan = buildWorkerRuntimePlan(environment)
    lifecycle = "bootstrapping"

    try {
      await dependencies.checkConnections()
      logger.info("worker runtime selected", {
        mode: plan.mode,
        capabilities: plan.capabilities,
        workerFactories: plan.workerFactories,
        ...(plan.mode === "scheduled" ? { taskName: plan.taskName } : {}),
      })

      if (hasCapability(plan, "object-storage")) {
        await dependencies.assertObjectStorageReadiness()
      }
      if (hasCapability(plan, "remove-hybrid-repeatables")) {
        await dependencies.removeHybridRepeatables()
      }
      if (hasCapability(plan, "health-server")) {
        await startHealthServer()
      }

      if (plan.mode !== "scheduled") {
        await startWorkers(plan.workerFactories)
      }

      if (plan.mode === "all") {
        logger.info("legacy-compatible worker fleet started", {
          count: workers.length,
          workerFactories: plan.workerFactories,
        })
        await dependencies.registerLegacyRepeatables()
        lifecycle = "running"
        return { disposition: "running", plan }
      }

      if (plan.mode === "realtime") {
        logger.info("realtime worker lane started", {
          count: workers.length,
          workerFactories: plan.workerFactories,
        })
        lifecycle = "running"
        return { disposition: "running", plan }
      }

      if (plan.mode === "on-demand") {
        logger.info("on-demand worker lane started", {
          count: workers.length,
          workerFactories: plan.workerFactories,
        })
        await dependencies.drainOnDemandQueues()
        await cleanup("on-demand-complete")
        return { disposition: "completed", plan }
      }

      if (hasCapability(plan, "maintenance-dispatch")) {
        await dependencies.runMaintenanceDispatch()
      } else {
        await dependencies.runScheduledTask(plan as ScheduledTaskRuntimePlan)
      }
      await cleanup(`scheduled-complete:${plan.taskName}`)
      return { disposition: "completed", plan }
    } catch (error) {
      // A factory can fail after earlier workers or the health server were
      // constructed. Always drain those partial resources, but preserve the
      // originating bootstrap error as the rejection seen by the caller.
      try {
        await cleanup("bootstrap-failed")
      } catch (cleanupError) {
        logger.error("bootstrap cleanup also failed", {
          err:
            cleanupError instanceof Error
              ? cleanupError.message
              : String(cleanupError),
        })
      }
      throw error
    }
  }

  return {
    bootstrap,
    shutdown: cleanup,
  }
}

export type WorkerProcessSignal = "SIGTERM" | "SIGINT"

export interface WorkerSignalTarget {
  on(signal: WorkerProcessSignal, listener: () => void): unknown
  off?(signal: WorkerProcessSignal, listener: () => void): unknown
}

export interface WorkerSignalHandlers {
  onSignal?(signal: WorkerProcessSignal): void
  onShutdownComplete(signal: WorkerProcessSignal): void | Promise<void>
  onShutdownError(
    error: unknown,
    signal: WorkerProcessSignal,
  ): void | Promise<void>
}

/**
 * Installs process-signal wiring without importing or mutating `process` in
 * this module. The injected target makes TERM behavior deterministic in unit
 * tests and keeps process exit policy in the executable entrypoint.
 */
export function installWorkerSignalHandlers(
  runtime: Pick<WorkerRuntime, "shutdown">,
  target: WorkerSignalTarget,
  handlers: WorkerSignalHandlers,
): () => void {
  let shutdownStarted = false
  const listeners = new Map<WorkerProcessSignal, () => void>()

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const listener = () => {
      if (shutdownStarted) return
      shutdownStarted = true
      handlers.onSignal?.(signal)
      void runtime
        .shutdown(signal)
        .then(() => handlers.onShutdownComplete(signal))
        .catch((error) => handlers.onShutdownError(error, signal))
    }
    listeners.set(signal, listener)
    target.on(signal, listener)
  }

  return () => {
    if (!target.off) return
    for (const [signal, listener] of listeners) {
      target.off(signal, listener)
    }
  }
}
