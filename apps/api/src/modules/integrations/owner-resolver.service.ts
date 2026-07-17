import type { OwnerContext } from "@guestpost/integrations"
import {
  IntegrationError,
  IntegrationOwnerType,
  PermissionDeniedError,
} from "@guestpost/integrations"
import { Injectable } from "@nestjs/common"
import { Request } from "express"
import { PrismaService } from "../../common/prisma.service"

@Injectable()
export class OwnerResolver {
  constructor(private readonly prisma: PrismaService) {}

  async resolve(
    req: Request,
    platformWebsiteId?: string,
  ): Promise<OwnerContext> {
    const user = (req as any).user

    // Platform Google credentials are isolated per website. This prevents one
    // operator from reading or mutating another site's Google account while
    // still allowing a different Google identity from the GuestPost login.
    if (user?.userType === "STAFF" || user?.staffRole) {
      if (
        !platformWebsiteId ||
        !["SUPER_ADMIN", "OPERATIONS"].includes(user.staffRole)
      ) {
        throw new PermissionDeniedError()
      }

      const website = await this.prisma.website.findFirst({
        where: {
          id: platformWebsiteId,
          ownershipType: "PLATFORM",
          ...(user.staffRole === "OPERATIONS"
            ? { managedByUserId: user.id }
            : {}),
        },
        select: { id: true },
      })
      // Use the same response for a missing and an unassigned site so this
      // endpoint cannot be used to enumerate platform inventory.
      if (!website) throw new PermissionDeniedError()

      return {
        ownerType: IntegrationOwnerType.PLATFORM,
        ownerId: website.id,
      }
    }

    // Never fall back to the user id: publisher integrations belong to the
    // active Publisher aggregate and must follow PublisherMembership context.
    const publisherId = user?.publisherId
    if (!publisherId) {
      throw new IntegrationError("UNAUTHORIZED", "Publisher not found")
    }
    return { ownerType: IntegrationOwnerType.PUBLISHER, ownerId: publisherId }
  }
}
