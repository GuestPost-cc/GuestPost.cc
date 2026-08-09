import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { MEMBER_ROLES_KEY } from "../decorators/member-roles.decorator"
import { PrismaService } from "../prisma.service"

@Injectable()
export class MemberRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      MEMBER_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!requiredRoles) return true

    const user = context.switchToHttp().getRequest().user

    if (!user) {
      throw new ForbiddenException("Authentication required")
    }

    // The auth-context cache is a request projection, not an authorization
    // authority. Resolve the current durable context and membership on every
    // role-protected request so a missed Redis invalidation cannot preserve a
    // revoked role or an old organization/publisher selection.
    let userRole: string | null = null
    if (user.userType === "CUSTOMER") {
      const activeContext = await this.prisma.activeContext.findUnique({
        where: { userId: user.id },
        select: { activeOrganizationId: true },
      })
      const organizationId = activeContext?.activeOrganizationId ?? null
      const membership = organizationId
        ? await this.prisma.membership.findUnique({
            where: {
              userId_organizationId: {
                userId: user.id,
                organizationId,
              },
            },
            select: {
              role: true,
              status: true,
              user: { select: { banned: true, userType: true } },
            },
          })
        : null
      if (
        membership?.status === "ACTIVE" &&
        membership.user.banned === false &&
        membership.user.userType === "CUSTOMER"
      ) {
        userRole = membership.role
        user.organizationId = organizationId
        user.customerRole = membership.role
        user.memberRole = membership.role
      }
    } else if (user.userType === "PUBLISHER") {
      const activeContext = await this.prisma.activeContext.findUnique({
        where: { userId: user.id },
        select: { activePublisherId: true },
      })
      const publisherId = activeContext?.activePublisherId ?? null
      const membership = publisherId
        ? await this.prisma.publisherMembership.findFirst({
            where: { userId: user.id, publisherId },
            select: {
              role: true,
              user: { select: { banned: true, userType: true } },
              publisher: { select: { organizationId: true } },
            },
          })
        : null
      if (
        membership &&
        membership.user.banned === false &&
        membership.user.userType === "PUBLISHER"
      ) {
        userRole = membership.role
        user.publisherId = publisherId
        user.publisherOrganizationId = membership.publisher.organizationId
        user.publisherRole = membership.role
      }
    } else if (user.userType === "STAFF") {
      const membership = await this.prisma.staffMembership.findUnique({
        where: { userId: user.id },
        select: {
          role: true,
          user: { select: { banned: true, userType: true } },
        },
      })
      if (
        membership &&
        membership.user.banned === false &&
        membership.user.userType === "STAFF"
      ) {
        userRole = membership.role
        user.staffRole = membership.role
      }
    }

    if (!userRole) {
      throw new ForbiddenException("You are not a member of any organization")
    }

    if (!requiredRoles.includes(userRole)) {
      throw new ForbiddenException("Insufficient organization role")
    }

    return true
  }
}
