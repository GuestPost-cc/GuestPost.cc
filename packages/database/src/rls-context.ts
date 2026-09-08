import { Prisma, type PrismaClient } from "./prisma/client"

/**
 * The only tenant context currently eligible for database-enforced access.
 *
 * This deliberately accepts durable authorization facts, not an HTTP request
 * or a client-supplied object. Callers must derive it after session validation
 * and current-authority resolution.
 */
export interface OrganizationOwnerRlsContext {
  actorId: string
  organizationId: string
  actorKind: "CUSTOMER"
  organizationRole: "OWNER"
}

export interface ApiKeyValidationRlsContext {
  keyHash: string
}

type RlsTransactionClient = Prisma.TransactionClient
type RlsTransactionHost = Pick<PrismaClient, "$transaction">

function assertIdentifier(name: string, value: string): void {
  if (!value || value.length > 191 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid RLS ${name}`)
  }
}

/**
 * Pins verified actor facts to the exact interactive transaction used for the
 * protected statements. PostgreSQL clears all values at commit/rollback, so a
 * pooled connection cannot carry one request's tenant context into another.
 */
export async function withOrganizationOwnerRlsContext<T>(
  prisma: RlsTransactionHost,
  context: OrganizationOwnerRlsContext,
  operation: (tx: RlsTransactionClient) => Promise<T>,
): Promise<T> {
  assertIdentifier("actor id", context.actorId)
  assertIdentifier("organization id", context.organizationId)

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`
        SELECT
          set_config('guestpost.rls_workload', 'API', true),
          set_config('guestpost.rls_actor_kind', ${context.actorKind}, true),
          set_config('guestpost.rls_actor_id', ${context.actorId}, true),
          set_config('guestpost.rls_organization_id', ${context.organizationId}, true),
          set_config('guestpost.rls_organization_role', ${context.organizationRole}, true)
      `,
    )

    return operation(tx)
  })
}

/**
 * The opaque presented-key path may only see and touch the one matching key.
 * It intentionally cannot assume a tenant, actor, worker, or staff context.
 */
export async function withApiKeyValidationRlsContext<T>(
  prisma: RlsTransactionHost,
  context: ApiKeyValidationRlsContext,
  operation: (tx: RlsTransactionClient) => Promise<T>,
): Promise<T> {
  if (!/^[a-f0-9]{64}$/.test(context.keyHash)) {
    throw new Error("Invalid RLS key hash")
  }

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`
        SELECT
          set_config('guestpost.rls_workload', 'API_KEY_AUTH', true),
          set_config('guestpost.rls_api_key_hash', ${context.keyHash}, true)
      `,
    )

    return operation(tx)
  })
}
