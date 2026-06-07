import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { auth } from "@guestpost/auth"
import { prisma } from "@guestpost/database"
import { IS_PUBLIC_KEY } from "./public.decorator"

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true

    const request = context.switchToHttp().getRequest()
    const session = await auth.api.getSession({
      headers: request.headers,
    })

    if (!session) throw new UnauthorizedException()

    const user = await prisma.user.findUnique({ where: { id: session.user.id } })

    if (!user) {
      throw new UnauthorizedException("User not found")
    }

    if (user.banned) {
      throw new ForbiddenException("Account is banned")
    }

    let organizationId: string | null = null
    let customerRole: string | null = null
    let publisherId: string | null = null
    let publisherRole: string | null = null
    let staffRole: string | null = null

    if (user.userType === "CUSTOMER") {
      const membership = await prisma.membership.findFirst({
        where: { userId: user.id },
        orderBy: { createdAt: "asc" },
      })
      organizationId = membership?.organizationId ?? null
      customerRole = membership?.role ?? null
    } else if (user.userType === "PUBLISHER") {
      const pubMembership = await prisma.publisherMembership.findFirst({
        where: { userId: user.id },
        include: { publisher: true },
        orderBy: { createdAt: "asc" },
      })
      publisherId = pubMembership?.publisherId ?? null
      publisherRole = pubMembership?.role ?? null
      organizationId = pubMembership?.publisher?.organizationId ?? null
    } else if (user.userType === "STAFF") {
      const staffMembership = await prisma.staffMembership.findUnique({
        where: { userId: user.id },
      })
      staffRole = staffMembership?.role ?? null
    }

    request.user = {
      ...user,
      organizationId,
      customerRole,
      memberRole: customerRole,
      publisherId,
      publisherRole,
      staffRole,
    }
    request.session = session.session
    return true
  }
}
