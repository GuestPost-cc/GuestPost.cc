import { auth } from "@guestpost/auth"
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import {
  getCachedAuthContext,
  setCachedAuthContext,
} from "../../common/auth-context-cache"
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator"
import { PrismaService } from "../../common/prisma.service"
import { isTrustedOrigin } from "../../common/security/trusted-origins"
import { ActiveContextService } from "../active-context/active-context.service"
import { requiresEmailVerification } from "./email-verification-policy"

const PUBLIC_SESSION_ABSOLUTE_AGE_MS = 24 * 60 * 60 * 1000
const STAFF_SESSION_ABSOLUTE_AGE_MS = 8 * 60 * 60 * 1000

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private readonly prisma: PrismaService,
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

    const createdAt = new Date(session.session.createdAt).getTime()
    const sessionUserType = (session.user as { userType?: string }).userType
    const absoluteAge =
      sessionUserType === "CUSTOMER" || sessionUserType === "PUBLISHER"
        ? PUBLIC_SESSION_ABSOLUTE_AGE_MS
        : STAFF_SESSION_ABSOLUTE_AGE_MS
    if (!Number.isFinite(createdAt) || Date.now() - createdAt > absoluteAge) {
      await this.prisma.session.deleteMany({
        where: { id: session.session.id },
      })
      throw new UnauthorizedException("SESSION_EXPIRED")
    }

    // ── CSRF protection for state-changing requests ──
    // Validate the Origin header against the configured allowlist.
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const origin = request.headers.origin || request.headers.referer
      if (origin && !isTrustedOrigin(origin)) {
        throw new ForbiddenException("Cross-origin request denied")
      }
    }

    // Session is verified above on every request; the derived context (user
    // row, active org/publisher, roles) is cached briefly. Mutations that
    // change it call invalidateAuthContext().
    const cached = getCachedAuthContext(session.user.id)
    if (cached) {
      // Phase 7.8 #25 — verification gate runs on the cache-hit path too;
      // otherwise an unverified user who first hits an exempt GET path
      // could bypass the gate on subsequent POSTs within the 30s TTL.
      if (!cached.emailVerified && requiresEmailVerification(request)) {
        throw new ForbiddenException("EMAIL_NOT_VERIFIED")
      }
      request.user = cached
      request.session = session.session
      return true
    }

    const user = await this.prisma.user.findUnique({
      where: { id: session.user.id },
    })
    if (!user) throw new UnauthorizedException("User not found")
    if (user.banned) throw new ForbiddenException("Account is banned")

    // Phase 7.8 #25 + AUTH-04: All user types require a verified email for
    // state-changing operations. GET reads + sign-out + verification-resend
    // endpoints stay open so locked-out users can act on the lockout.
    if (!user.emailVerified && requiresEmailVerification(request)) {
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
        const membership = await this.prisma.membership.findUnique({
          where: {
            userId_organizationId: {
              userId: user.id,
              organizationId: activeOrganizationId,
            },
          },
        })
        if (membership?.status !== "ACTIVE") {
          await this.activeContext.clearOrganization(user.id)
          activeOrganizationId = null
        }
      }

      if (!activeOrganizationId) {
        const fallback = await this.prisma.membership.findFirst({
          where: { userId: user.id, status: "ACTIVE" },
          orderBy: { createdAt: "asc" },
        })
        if (fallback) {
          activeOrganizationId = fallback.organizationId
          await this.activeContext.setActiveOrganization(
            user.id,
            fallback.organizationId,
          )
        }
      }
    } else if (user.userType === "PUBLISHER") {
      const ctx = await this.activeContext.getOrCreate(user.id)
      activePublisherId = ctx.activePublisherId

      if (activePublisherId) {
        const membership = await this.prisma.publisherMembership.findFirst({
          where: { userId: user.id, publisherId: activePublisherId },
        })
        if (!membership) {
          await this.activeContext.clearPublisher(user.id)
          activePublisherId = null
        }
      }

      if (!activePublisherId) {
        const fallback = await this.prisma.publisherMembership.findFirst({
          where: { userId: user.id },
          orderBy: { createdAt: "asc" },
        })
        if (fallback) {
          activePublisherId = fallback.publisherId
          await this.activeContext.setActivePublisher(
            user.id,
            fallback.publisherId,
          )
        }
      }

      if (activePublisherId) {
        const publisher = await this.prisma.publisher.findUnique({
          where: { id: activePublisherId },
        })
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
