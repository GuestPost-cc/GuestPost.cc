import { createPrismaClient } from "./create-prisma-client"
import { PrismaClient } from "./prisma/client"
import { createRlsAwarePrismaClient } from "./rls-prisma-proxy"

export type {
  CreatePrismaAdapterOptions,
  CreatePrismaClientOptions,
} from "./create-prisma-client"
export {
  createPrismaAdapter,
  createPrismaClient,
  PRISMA_POOL_MAX_DEFAULT,
  PRISMA_POOL_MAX_RECOMMENDED,
  parsePoolMax,
} from "./create-prisma-client"
export * from "./prisma/client"
export {
  RLS_BOUNDARY_MODELS,
  RLS_MODEL_NAMES,
  type RlsBoundaryRoot,
} from "./rls-boundary-manifest"
export { RLS_RAW_CLIENT } from "./rls-client-symbol"
export {
  type ApiKeyValidationRlsContext,
  type ApplicationRlsContext,
  type AuthBootstrapRlsContext,
  type CustomerRlsContext,
  type OrganizationOwnerRlsContext,
  type PublicRlsContext,
  type PublisherRlsContext,
  type StaffRlsContext,
  setApplicationRlsContext,
  type WebhookRlsContext,
  type WorkerRlsContext,
  withApiKeyValidationRlsContext,
  withApplicationRlsContext,
  withOrganizationOwnerRlsContext,
} from "./rls-context"
export { createRlsAwarePrismaClient } from "./rls-prisma-proxy"
export {
  getRlsRequestContext,
  isRlsEnforcementEnabled,
  requireRlsRequestContext,
  runWithRlsRequestScope,
  setRlsRequestContext,
} from "./rls-request-context"
export { PrismaClient }

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined
}

export const prisma =
  globalForPrisma.prisma ?? createRlsAwarePrismaClient(createPrismaClient())

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma
}
