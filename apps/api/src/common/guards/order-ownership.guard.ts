import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { ORDER_OWNERSHIP_KEY } from "../decorators/order-ownership.decorator"
import { PrismaService } from "../prisma.service"

@Injectable()
export class OrderOwnershipGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<boolean>(
      ORDER_OWNERSHIP_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!required) return true

    const request = context.switchToHttp().getRequest()
    const user = request.user
    const paramId = request.params.id

    if (!user) {
      throw new ForbiddenException("Authentication required")
    }
    if (!paramId) {
      throw new ForbiddenException("Order identifier is required")
    }

    // Phase 6.5: also pull fulfillmentChannel so we can refuse access when
    // a publisher's website later gets reassigned out from under them.
    const orderSelect = {
      id: true,
      organizationId: true,
      fulfillmentChannel: true,
      website: { select: { publisherId: true, ownershipType: true } },
    }

    // Routes like /settlements/:id pass a settlement ID — resolve it to its order
    let order = await this.prisma.order.findUnique({
      where: { id: paramId },
      select: orderSelect,
    })
    if (!order) {
      const settlement = await this.prisma.settlement.findUnique({
        where: { id: paramId },
        select: { order: { select: orderSelect } },
      })
      order = settlement?.order ?? null
    }

    if (!order) {
      throw new NotFoundException("Order not found")
    }

    if (user.userType === "CUSTOMER") {
      if (order.organizationId !== user.organizationId) {
        throw new ForbiddenException(
          "Order does not belong to your organization",
        )
      }
      return true
    }

    if (user.userType === "PUBLISHER") {
      if (order.website?.publisherId !== user.publisherId) {
        throw new ForbiddenException(
          "Order is not assigned to your publisher account",
        )
      }
      // Channel consistency: a publisher should never operate on an order
      // whose snapshotted channel is PLATFORM (would mean a stale view of a
      // recently-reassigned website). Restrictive-only — never grants access.
      const channel =
        order.fulfillmentChannel ??
        (order.website?.ownershipType === "PLATFORM" ? "PLATFORM" : "PUBLISHER")
      if (channel === "PLATFORM") {
        throw new ForbiddenException(
          "Order has been reassigned to platform fulfilment",
        )
      }
      return true
    }

    // Fail closed. STAFF use the dedicated /admin order surfaces, which apply
    // role- and assignment-aware scoping. Letting staff (or a future userType)
    // fall through here would bypass those narrower policies on the generic
    // customer/publisher routes.
    throw new ForbiddenException("Order access is not available for this actor")
  }
}
