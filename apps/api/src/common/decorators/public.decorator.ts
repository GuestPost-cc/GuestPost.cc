import type { WebhookRlsContext } from "@guestpost/database"
import { applyDecorators, SetMetadata } from "@nestjs/common"

export const IS_PUBLIC_KEY = "isPublic"
export const PUBLIC_RLS_CONTEXT_KEY = "publicRlsContext"
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true)

export const PublicWebhook = (ingress: WebhookRlsContext["ingress"]) =>
  applyDecorators(
    SetMetadata(IS_PUBLIC_KEY, true),
    SetMetadata(PUBLIC_RLS_CONTEXT_KEY, {
      workload: "WEBHOOK",
      ingress,
    } satisfies WebhookRlsContext),
  )
