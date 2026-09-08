import type { Prisma, PrismaClient } from "./prisma/client"
import { RLS_MODEL_NAMES } from "./rls-boundary-manifest"
import { RLS_RAW_CLIENT } from "./rls-client-symbol"
import { setApplicationRlsContext } from "./rls-context"
import {
  isRlsEnforcementEnabled,
  requireRlsRequestContext,
} from "./rls-request-context"

const modelDelegates = new Set(
  RLS_MODEL_NAMES.map((name) => `${name[0].toLowerCase()}${name.slice(1)}`),
)

/**
 * Adds transaction-local RLS context to every Prisma operation while keeping
 * explicit interactive transactions atomic. The proxy is dynamically inert
 * until RLS_ENFORCEMENT_ENABLED=true.
 */
export function createRlsAwarePrismaClient<T extends PrismaClient>(
  client: T,
): T {
  const rootTransaction = client.$transaction.bind(client) as any

  const runContextualized = (
    operation: (tx: Prisma.TransactionClient) => unknown,
    options?: unknown,
  ): Promise<unknown> => {
    const context = requireRlsRequestContext()
    return rootTransaction(async (tx: Prisma.TransactionClient) => {
      await setApplicationRlsContext(tx, context)
      return operation(tx)
    }, options)
  }

  return new Proxy(client, {
    get(target, property) {
      if (property === RLS_RAW_CLIENT) return target
      const value = Reflect.get(target, property, target)
      if (!isRlsEnforcementEnabled() || typeof property !== "string") {
        return typeof value === "function" ? value.bind(target) : value
      }

      if (modelDelegates.has(property)) {
        return new Proxy(value as object, {
          get(delegate, method) {
            const delegateValue = Reflect.get(delegate, method, delegate)
            if (typeof delegateValue !== "function") return delegateValue
            return (...args: unknown[]) =>
              runContextualized((tx) => {
                const txDelegate = Reflect.get(tx, property, tx)
                return Reflect.get(txDelegate, method, txDelegate).apply(
                  txDelegate,
                  args,
                )
              })
          },
        })
      }

      if (
        property === "$queryRaw" ||
        property === "$executeRaw" ||
        property === "$queryRawUnsafe" ||
        property === "$executeRawUnsafe"
      ) {
        return (...args: unknown[]) =>
          runContextualized((tx) => {
            const rawMethod = Reflect.get(tx, property, tx) as (
              ...args: any[]
            ) => unknown
            return rawMethod.apply(tx, args)
          })
      }

      if (property === "$transaction") {
        return (operation: unknown, options?: unknown) => {
          if (typeof operation !== "function") {
            throw new Error(
              "Array-form Prisma transactions are disabled under RLS; use an interactive transaction",
            )
          }
          return runContextualized(
            operation as (tx: Prisma.TransactionClient) => unknown,
            options,
          )
        }
      }

      return typeof value === "function" ? value.bind(target) : value
    },
  })
}
