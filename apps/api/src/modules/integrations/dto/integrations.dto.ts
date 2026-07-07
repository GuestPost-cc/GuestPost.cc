import {
  IntegrationProvider,
  IntegrationSyncTrigger,
} from "@guestpost/integrations"
import { z } from "zod"

export const ConnectRequestSchema = z.object({
  provider: z.nativeEnum(IntegrationProvider),
  returnUrl: z.string().optional().default("/dashboard"),
})

export const ConnectCallbackRequestSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
  error: z.string().optional(),
})

export const LinkPropertyRequestSchema = z.object({
  propertyUrl: z.string().url(),
  websiteId: z.string().cuid(),
})

export const TriggerSyncRequestSchema = z.object({
  trigger: z
    .nativeEnum(IntegrationSyncTrigger)
    .optional()
    .default(IntegrationSyncTrigger.MANUAL),
  propertyUrl: z.string().url().optional(),
  startDate: z.string().datetime().optional(),
  endDate: z.string().datetime().optional(),
})

export const DisconnectRequestSchema = z.object({
  integrationId: z.string().cuid(),
})

export type ConnectRequest = z.infer<typeof ConnectRequestSchema>
export type ConnectCallbackRequest = z.infer<
  typeof ConnectCallbackRequestSchema
>
export type LinkPropertyRequest = z.infer<typeof LinkPropertyRequestSchema>
export type TriggerSyncRequest = z.infer<typeof TriggerSyncRequestSchema>
export type DisconnectRequest = z.infer<typeof DisconnectRequestSchema>
