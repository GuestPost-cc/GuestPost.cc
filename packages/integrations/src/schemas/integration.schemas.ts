import { z } from "zod"
import {
  IntegrationOwnerType,
  IntegrationProvider,
  IntegrationStatus,
  IntegrationSyncStatus,
  IntegrationSyncTrigger,
  WebsiteIntegrationStatus,
} from "../types"

// ─── Request Schemas ────────────────────────────────────────────

export const connectRequestSchema = z.object({
  provider: z.nativeEnum(IntegrationProvider),
  returnUrl: z.string().optional().default("/dashboard"),
})

export const connectCallbackRequestSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  error: z.string().optional(),
})

export const listIntegrationsRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.nativeEnum(IntegrationStatus).optional(),
  provider: z.nativeEnum(IntegrationProvider).optional(),
})

export const linkPropertyRequestSchema = z.object({
  externalResourceId: z.string().min(1),
  websiteId: z.string().cuid(),
})

export const triggerDiscoveryRequestSchema = z.object({})

export const triggerSyncRequestSchema = z.object({
  trigger: z
    .nativeEnum(IntegrationSyncTrigger)
    .default(IntegrationSyncTrigger.MANUAL),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
  websiteIntegrationId: z.string().optional(),
})

export const getSyncHistoryRequestSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  status: z.nativeEnum(IntegrationSyncStatus).optional(),
  trigger: z.nativeEnum(IntegrationSyncTrigger).optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
})

// ─── Response Schemas ───────────────────────────────────────────

const linkedWebsiteSchema = z.object({
  id: z.string(),
  websiteId: z.string(),
  externalResourceId: z.string(),
  externalResourceName: z.string().nullable(),
  status: z.nativeEnum(WebsiteIntegrationStatus),
  syncedAt: z.string().datetime().nullable(),
})

const paginationSchema = z.object({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  hasNext: z.boolean(),
})

export const integrationResponseSchema = z.object({
  id: z.string(),
  ownerType: z.nativeEnum(IntegrationOwnerType),
  ownerId: z.string(),
  provider: z.nativeEnum(IntegrationProvider),
  status: z.nativeEnum(IntegrationStatus),
  linkedWebsites: z.array(linkedWebsiteSchema),
  connection: z
    .object({
      email: z.string().nullable(),
      displayName: z.string().nullable(),
      grantedScopes: z.array(z.string()),
      status: z.string(),
    })
    .nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
})

export const integrationListResponseSchema = z.object({
  data: z.array(integrationResponseSchema),
  pagination: paginationSchema,
})

export const discoveredResourceSchema = z.object({
  externalResourceId: z.string(),
  externalResourceName: z.string().nullable(),
  metadata: z.record(z.unknown()).nullable(),
})

export const discoverResourcesResponseSchema = z.object({
  resources: z.array(discoveredResourceSchema),
  discoveredAt: z.string().datetime().nullable(),
  isStale: z.boolean(),
})

export const linkPropertyResponseSchema = z.object({
  externalResourceId: z.string(),
  externalResourceName: z.string().nullable(),
  alreadyLinked: z.boolean(),
  linkedWebsiteId: z.string().nullable().optional(),
  linkedWebsiteUrl: z.string().nullable().optional(),
})

const syncProgressSchema = z.object({
  completed: z.number(),
  total: z.number(),
})

export const syncJobResponseSchema = z.object({
  id: z.string(),
  integrationId: z.string(),
  jobType: z.string(),
  websiteIntegrationId: z.string().nullable(),
  status: z.nativeEnum(IntegrationSyncStatus),
  trigger: z.nativeEnum(IntegrationSyncTrigger),
  recordsProcessed: z.number(),
  progress: syncProgressSchema,
  errorMessage: z.string().nullable(),
  startedAt: z.string().datetime(),
  completedAt: z.string().datetime().nullable(),
})

export const triggerSyncResponseSchema = z.object({
  syncId: z.string(),
  websiteIntegrationIds: z.array(z.string()),
})

export const syncHistoryResponseSchema = z.object({
  data: z.array(syncJobResponseSchema),
  pagination: paginationSchema,
})

export const connectResponseSchema = z.object({
  authorizationUrl: z.string(),
})

export const enqueueDiscoveryResponseSchema = z.object({
  enqueued: z.boolean(),
})

// ─── Inferred Types ─────────────────────────────────────────────

export type ConnectRequest = z.infer<typeof connectRequestSchema>
export type ConnectCallbackRequest = z.infer<
  typeof connectCallbackRequestSchema
>
export type ListIntegrationsRequest = z.infer<
  typeof listIntegrationsRequestSchema
>
export type LinkPropertyRequest = z.infer<typeof linkPropertyRequestSchema>
export type TriggerDiscoveryRequest = z.infer<
  typeof triggerDiscoveryRequestSchema
>
export type TriggerSyncRequest = z.infer<typeof triggerSyncRequestSchema>
export type GetSyncHistoryRequest = z.infer<typeof getSyncHistoryRequestSchema>

export type LinkedWebsite = z.infer<typeof linkedWebsiteSchema>
export type Pagination = z.infer<typeof paginationSchema>
export type IntegrationSummary = z.infer<typeof integrationResponseSchema>
export type IntegrationListResponse = z.infer<
  typeof integrationListResponseSchema
>
export type DiscoverResourcesResponse = z.infer<
  typeof discoverResourcesResponseSchema
>
export type LinkPropertyResponse = z.infer<typeof linkPropertyResponseSchema>
export type SyncJob = z.infer<typeof syncJobResponseSchema>
export type TriggerSyncResponse = z.infer<typeof triggerSyncResponseSchema>
export type SyncHistoryResponse = z.infer<typeof syncHistoryResponseSchema>
export type ConnectResponse = z.infer<typeof connectResponseSchema>
export type EnqueueDiscoveryResponse = z.infer<
  typeof enqueueDiscoveryResponseSchema
>
