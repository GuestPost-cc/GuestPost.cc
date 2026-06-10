import { Injectable, CanActivate, ExecutionContext, ForbiddenException, NotFoundException } from "@nestjs/common"
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
    const required = this.reflector.getAllAndOverride<boolean>(ORDER_OWNERSHIP_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!required) return true

    const request = context.switchToHttp().getRequest()
    const user = request.user
    const paramId = request.params.id

    if (!paramId) return true

    const orderSelect = { id: true, organizationId: true, website: { select: { publisherId: true } } }

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
        throw new ForbiddenException("Order does not belong to your organization")
      }
      return true
    }

    if (user.userType === "PUBLISHER") {
      if (order.website?.publisherId !== user.publisherId) {
        throw new ForbiddenException("Order is not assigned to your publisher account")
      }
      return true
    }

    return true
  }
}
