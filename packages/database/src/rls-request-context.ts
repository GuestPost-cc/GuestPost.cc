import { AsyncLocalStorage } from "node:async_hooks"
import type { ApplicationRlsContext } from "./rls-context"

interface RlsRequestStore {
  context: ApplicationRlsContext | null
}

const storage = new AsyncLocalStorage<RlsRequestStore>()

export function isRlsEnforcementEnabled(): boolean {
  return process.env.RLS_ENFORCEMENT_ENABLED === "true"
}

export function runWithRlsRequestScope<T>(operation: () => T): T {
  return storage.run({ context: null }, operation)
}

export function setRlsRequestContext(context: ApplicationRlsContext): void {
  const store = storage.getStore()
  if (!store) {
    if (isRlsEnforcementEnabled()) {
      throw new Error("RLS request scope is not initialized")
    }
    return
  }
  store.context = Object.freeze({ ...context }) as ApplicationRlsContext
}

export function getRlsRequestContext(): ApplicationRlsContext | null {
  return storage.getStore()?.context ?? null
}

export function requireRlsRequestContext(): ApplicationRlsContext {
  const context = getRlsRequestContext()
  if (!context) throw new Error("RLS context is required for database access")
  return context
}
