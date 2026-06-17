import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { auth } from "@guestpost/auth"
import { prisma } from "@guestpost/database"
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator"
import { ActiveContextService } from "../active-context/active-context.service"
import { getCachedAuthContext, setCachedAuthContext } from "../../common/auth-context-cache"
import { requiresEmailVerification } from "./email-verification-policy"

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private readonly activeContext: ActiveContextService,
  ) {}

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

    // Session is verified above on every request; the derived context (user
    // row, active org/publisher, roles) is cached briefly. Mutations that
    // change it call invalidateAuthContext().
    const cached = getCachedAuthContext(session.user.id)
    if (cached) {
      // Phase 7.8 #25 — verification gate runs on the cache-hit path too;
      // otherwise an unverified user who first hits an exempt GET path
      // could bypass the gate on subsequent POSTs within the 30s TTL.
      if (
        cached.userType === "CUSTOMER" &&
        !cached.emailVerified &&
        requiresEmailVerification(request)
      ) {
        throw new ForbiddenException("EMAIL_NOT_VERIFIED")
      }
      request.user = cached
      request.session = session.session
      return true
    }

    const user = await prisma.user.findUnique({ where: { id: session.user.id } })
    if (!user) throw new UnauthorizedException("User not found")
    if (user.banned) throw new ForbiddenException("Account is banned")

    // Phase 7.8 #25 — CUSTOMER state-changing routes require a verified
    // email. GET reads + sign-out + verification-resend endpoints stay
    // open so locked-out users can act on the lockout. PUBLISHER/STAFF
    // unaffected (different verification tracks). Frontend should detect
    // the `EMAIL_NOT_VERIFIED` code and render a resend-banner.
    if (
      user.userType === "CUSTOMER" &&
      !user.emailVerified &&
      requiresEmailVerification(request)
    ) {
      throw new ForbiddenException("EMAIL_NOT_VERIFIED")
    }

    let activeOrganizationId: string | null = null
    let activePublisherId: string | null = null
    let publisherOrgId: string | null = null

    if (user.userType === "CUSTOMER") {
      const ctx = await this.activeContext.getOrCreate(user.id)
      activeOrganizationId = ctx.activeOrganizationId

      if (activeOrganizationId) {
        // Only ACTIVE memberships grant access — a PENDING (unaccepted) invite
        // must not let the user act in that org
        const membership = await prisma.membership.findUnique({
          where: { userId_organizationId: { userId: user.id, organizationId: activeOrganizationId } },
        })
        if (!membership || membership.status !== "ACTIVE") {
          await this.activeContext.clearOrganization(user.id)
          activeOrganizationId = null
        }
      }

      if (!activeOrganizationId) {
        const fallback = await prisma.membership.findFirst({
          where: { userId: user.id, status: "ACTIVE" },
          orderBy: { createdAt: "asc" },
        })
        if (fallback) {
          activeOrganizationId = fallback.organizationId
          await this.activeContext.setActiveOrganization(user.id, fallback.organizationId)
        }
      }
    } else if (user.userType === "PUBLISHER") {
      const ctx = await this.activeContext.getOrCreate(user.id)
      activePublisherId = ctx.activePublisherId

      if (activePublisherId) {
        const membership = await prisma.publisherMembership.findFirst({
          where: { userId: user.id, publisherId: activePublisherId },
        })
        if (!membership) {
          await this.activeContext.clearPublisher(user.id)
          activePublisherId = null
        }
      }

      if (!activePublisherId) {
        const fallback = await prisma.publisherMembership.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: "asc" },
        })
        if (fallback) {
          activePublisherId = fallback.publisherId
          await this.activeContext.setActivePublisher(user.id, fallback.publisherId)
        }
      }

      if (activePublisherId) {
        const publisher = await prisma.publisher.findUnique({ where: { id: activePublisherId } })
        publisherOrgId = publisher?.organizationId ?? null
      }
    }

    const roles = await this.activeContext.resolveRoles(
      user.id,
      activeOrganizationId,
      activePublisherId,
    )

    request.user = {
      ...user,
      organizationId: activeOrganizationId,
      publisherId: activePublisherId,
      publisherOrganizationId: publisherOrgId,
      ...roles,
    }
    setCachedAuthContext(user.id, request.user)
    request.session = session.session
    return true
  }
}
