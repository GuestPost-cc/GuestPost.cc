import type { OwnerContext } from "@guestpost/integrations"
import { IntegrationError, IntegrationOwnerType } from "@guestpost/integrations"
import { Injectable } from "@nestjs/common"
import { Request } from "express"

@Injectable()
export class OwnerResolver {
  resolve(req: Request): OwnerContext {
    const publisherId = (req as any).user?.publisherId ?? (req as any).user?.sub
    if (!publisherId) {
      throw new IntegrationError("UNAUTHORIZED", "Publisher not found")
    }
    return { ownerType: IntegrationOwnerType.PUBLISHER, ownerId: publisherId }
  }
}
