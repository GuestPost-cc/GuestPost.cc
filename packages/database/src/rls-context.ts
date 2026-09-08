import { Prisma, type PrismaClient } from "./prisma/client"
import { RLS_RAW_CLIENT } from "./rls-client-symbol"

/** Backward-compatible owner-only shape used by the Phase 1 API-key service. */
export interface OrganizationOwnerRlsContext {
  actorId: string
  organizationId: string
  actorKind: "CUSTOMER"
  organizationRole: "OWNER"
}

export interface ApiKeyValidationRlsContext {
  keyHash: string
}

export interface CustomerRlsContext {
  workload: "API"
  actorId: string
  actorKind: "CUSTOMER"
  organizationId: string | null
  organizationRole: "OWNER" | "MEMBER" | null
}

export interface PublisherRlsContext {
  workload: "API"
  actorId: string
  actorKind: "PUBLISHER"
  publisherId: string | null
  publisherRole: "PUBLISHER_OWNER" | "PUBLISHER_MEMBER" | null
}

export interface StaffRlsContext {
  workload: "API"
  actorId: string
  actorKind: "STAFF"
  staffRole: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null
  staffPermissions: readonly string[]
}

export interface AuthBootstrapRlsContext {
  workload: "AUTH_BOOTSTRAP"
  actorId: string
  actorKind: "CUSTOMER" | "PUBLISHER" | "STAFF"
}

export interface PublicRlsContext {
  workload: "PUBLIC"
}

export interface WebhookRlsContext {
  workload: "WEBHOOK"
  /** A fixed, server-selected ingress name; never a provider payload value. */
  ingress: "STRIPE" | "PAYOUT_PROVIDER" | "INTEGRATION_OAUTH"
}

export interface WorkerRlsContext {
  workload: "WORKER"
  /** The reviewed queue/processor name, not data supplied by a job producer. */
  worker: string
  /** Optional resource fence used by processors that operate on one aggregate. */
  resourceId?: string
}

export type ApplicationRlsContext =
  | CustomerRlsContext
  | PublisherRlsContext
  | StaffRlsContext
  | AuthBootstrapRlsContext
  | PublicRlsContext
  | WebhookRlsContext
  | WorkerRlsContext

type RlsTransactionClient = Prisma.TransactionClient
type RlsTransactionHost = Pick<PrismaClient, "$transaction">

function rawTransactionHost(prisma: RlsTransactionHost): RlsTransactionHost {
  return (
    (
      prisma as RlsTransactionHost & {
        [RLS_RAW_CLIENT]?: RlsTransactionHost
      }
    )[RLS_RAW_CLIENT] ?? prisma
  )
}

function assertIdentifier(name: string, value: string): void {
  if (!value || value.length > 191 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`Invalid RLS ${name}`)
  }
}

function assertPermission(value: string): void {
  if (!/^[A-Z][A-Z0-9_]{0,127}$/.test(value)) {
    throw new Error("Invalid RLS staff permission")
  }
}

/**
 * Replaces the complete transaction-local context in one statement.
 *
 * Clearing every unused setting is intentional. It makes context switching
 * within a request safe and protects against a future caller reusing an
 * already-contextualized transaction. Values are local to the transaction and
 * therefore cannot leak through Prisma's connection pool.
 */
export async function setApplicationRlsContext(
  tx: RlsTransactionClient,
  context: ApplicationRlsContext,
): Promise<void> {
  const actorId = "actorId" in context ? context.actorId : ""
  const actorKind = "actorKind" in context ? context.actorKind : ""
  const organizationId =
    "organizationId" in context ? (context.organizationId ?? "") : ""
  const organizationRole =
    "organizationRole" in context ? (context.organizationRole ?? "") : ""
  const publisherId =
    "publisherId" in context ? (context.publisherId ?? "") : ""
  const publisherRole =
    "publisherRole" in context ? (context.publisherRole ?? "") : ""
  const staffRole = "staffRole" in context ? (context.staffRole ?? "") : ""
  const staffPermissions =
    "staffPermissions" in context ? [...context.staffPermissions] : []
  const ingress = "ingress" in context ? context.ingress : ""
  const worker = "worker" in context ? context.worker : ""
  const resourceId = "resourceId" in context ? (context.resourceId ?? "") : ""

  if (actorId) assertIdentifier("actor id", actorId)
  if (organizationId) assertIdentifier("organization id", organizationId)
  if (publisherId) assertIdentifier("publisher id", publisherId)
  if (worker) assertIdentifier("worker", worker)
  if (resourceId) assertIdentifier("resource id", resourceId)
  for (const permission of staffPermissions) assertPermission(permission)

  await tx.$executeRaw(
    Prisma.sql`
      SELECT
        set_config('guestpost.rls_workload', ${context.workload}, true),
        set_config('guestpost.rls_actor_kind', ${actorKind}, true),
        set_config('guestpost.rls_actor_id', ${actorId}, true),
        set_config('guestpost.rls_organization_id', ${organizationId}, true),
        set_config('guestpost.rls_organization_role', ${organizationRole}, true),
        set_config('guestpost.rls_publisher_id', ${publisherId}, true),
        set_config('guestpost.rls_publisher_role', ${publisherRole}, true),
        set_config('guestpost.rls_staff_role', ${staffRole}, true),
        set_config('guestpost.rls_staff_permissions', ${JSON.stringify(staffPermissions)}, true),
        set_config('guestpost.rls_ingress', ${ingress}, true),
        set_config('guestpost.rls_worker', ${worker}, true),
        set_config('guestpost.rls_resource_id', ${resourceId}, true),
        set_config('guestpost.rls_api_key_hash', '', true)
    `,
  )
}

export async function withApplicationRlsContext<T>(
  prisma: RlsTransactionHost,
  context: ApplicationRlsContext,
  operation: (tx: RlsTransactionClient) => Promise<T>,
): Promise<T> {
  return rawTransactionHost(prisma).$transaction(async (tx) => {
    await setApplicationRlsContext(tx, context)
    return operation(tx)
  })
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
  return withApplicationRlsContext(
    prisma,
    {
      workload: "API",
      actorId: context.actorId,
      actorKind: context.actorKind,
      organizationId: context.organizationId,
      organizationRole: context.organizationRole,
    },
    operation,
  )
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

  return rawTransactionHost(prisma).$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`
        SELECT
          set_config('guestpost.rls_workload', 'API_KEY_AUTH', true),
          set_config('guestpost.rls_actor_kind', '', true),
          set_config('guestpost.rls_actor_id', '', true),
          set_config('guestpost.rls_organization_id', '', true),
          set_config('guestpost.rls_organization_role', '', true),
          set_config('guestpost.rls_publisher_id', '', true),
          set_config('guestpost.rls_publisher_role', '', true),
          set_config('guestpost.rls_staff_role', '', true),
          set_config('guestpost.rls_staff_permissions', '[]', true),
          set_config('guestpost.rls_ingress', '', true),
          set_config('guestpost.rls_worker', '', true),
          set_config('guestpost.rls_resource_id', '', true),
          set_config('guestpost.rls_api_key_hash', ${context.keyHash}, true)
      `,
    )

    return operation(tx)
  })
}
