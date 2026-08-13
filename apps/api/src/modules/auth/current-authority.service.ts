import type {
  CustomerRole,
  PublisherRole,
  StaffRole,
  UserRole,
  UserType,
} from "@guestpost/database"
import {
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"

export interface CurrentAuthority {
  id: string
  userType: UserType
  role: UserRole
  emailVerified: boolean
  organizationId: string | null
  publisherId: string | null
  publisherOrganizationId: string | null
  customerRole: CustomerRole | null
  memberRole: CustomerRole | null
  publisherRole: PublisherRole | null
  staffRole: StaffRole | null
  staffPermissions: readonly string[]
}

type CustomerAuthority = CurrentAuthority & {
  userType: "CUSTOMER"
  organizationId: string | null
  customerRole: CustomerRole | null
  memberRole: CustomerRole | null
  publisherId: null
  publisherOrganizationId: null
  publisherRole: null
  staffRole: null
}

type PublisherAuthority = CurrentAuthority & {
  userType: "PUBLISHER"
  organizationId: null
  customerRole: null
  memberRole: null
  publisherId: string | null
  publisherOrganizationId: string | null
  publisherRole: PublisherRole | null
  staffRole: null
}

type StaffAuthority = CurrentAuthority & {
  userType: "STAFF"
  organizationId: null
  customerRole: null
  memberRole: null
  publisherId: null
  publisherOrganizationId: null
  publisherRole: null
  staffRole: StaffRole | null
}

export type DurableCurrentAuthority =
  | CustomerAuthority
  | PublisherAuthority
  | StaffAuthority

const CURRENT_AUTHORITY_PROMISE = Symbol("current-authority-promise")

export interface AuthorityRequest {
  authenticatedUserId?: string
  session?: { userId?: string }
  // AuthGuard attaches a cached presentation projection here. It is accepted
  // only as request shape; durable resolution never trusts it as authority.
  user?: { id?: string; [key: string]: unknown }
  currentAuthority?: DurableCurrentAuthority
  [CURRENT_AUTHORITY_PROMISE]?: Promise<DurableCurrentAuthority>
}

function normalizePermissions(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return Object.freeze([])
  return Object.freeze([
    ...new Set(
      value.filter((item): item is string => typeof item === "string"),
    ),
  ])
}

/**
 * Resolves the authorization facts that are durable at request time.
 *
 * The process-local auth-context cache is intentionally not consulted here.
 * Resolution is memoized only on the current HTTP request so every new request
 * observes membership deletion, role demotion and active-context changes even
 * when Redis invalidation is dropped.
 */
@Injectable()
export class CurrentAuthorityService {
  constructor(private readonly prisma: PrismaService) {}

  async resolveRequest(
    request: AuthorityRequest,
  ): Promise<DurableCurrentAuthority> {
    const authenticatedUserId =
      request.authenticatedUserId ?? request.session?.userId
    if (
      request.currentAuthority &&
      authenticatedUserId &&
      request.currentAuthority.id === authenticatedUserId
    ) {
      return request.currentAuthority
    }
    if (
      request.currentAuthority &&
      authenticatedUserId &&
      request.currentAuthority.id !== authenticatedUserId
    ) {
      delete request.currentAuthority
      delete request[CURRENT_AUTHORITY_PROMISE]
    }
    if (request[CURRENT_AUTHORITY_PROMISE]) {
      return request[CURRENT_AUTHORITY_PROMISE]
    }

    const userId = authenticatedUserId
    if (!userId) {
      throw new UnauthorizedException("Authenticated session required")
    }

    const pending = this.resolveUser(userId)
    request[CURRENT_AUTHORITY_PROMISE] = pending
    try {
      const authority = await pending
      request.currentAuthority = authority
      return authority
    } catch (error) {
      delete request[CURRENT_AUTHORITY_PROMISE]
      throw error
    }
  }

  async resolveUser(userId: string): Promise<DurableCurrentAuthority> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        userType: true,
        role: true,
        banned: true,
        emailVerified: true,
        activeContext: {
          select: {
            activeOrganizationId: true,
            activePublisherId: true,
            activeOrganization: {
              select: {
                memberships: {
                  where: { userId, status: "ACTIVE" },
                  select: { role: true },
                  take: 1,
                },
              },
            },
            activePublisher: {
              select: {
                organizationId: true,
                publisherMemberships: {
                  where: { userId },
                  select: { role: true },
                  take: 1,
                },
              },
            },
          },
        },
        staffMemberships: {
          select: { role: true, permissions: true },
          take: 1,
        },
      },
    })

    if (!user) {
      throw new UnauthorizedException("Authority subject no longer exists")
    }
    if (user.banned) {
      throw new ForbiddenException({
        code: "ACCOUNT_SUSPENDED",
        message: "This account is suspended.",
      })
    }

    const context = user.activeContext
    const customerMembership =
      user.userType === "CUSTOMER"
        ? context?.activeOrganization?.memberships[0]
        : undefined
    const publisherMembership =
      user.userType === "PUBLISHER"
        ? context?.activePublisher?.publisherMemberships[0]
        : undefined
    const staffMembership =
      user.userType === "STAFF" ? user.staffMemberships[0] : undefined

    const organizationId = customerMembership
      ? (context?.activeOrganizationId ?? null)
      : null
    const publisherId = publisherMembership
      ? (context?.activePublisherId ?? null)
      : null

    return Object.freeze({
      id: user.id,
      userType: user.userType,
      role: user.role,
      emailVerified: user.emailVerified,
      organizationId,
      publisherId,
      publisherOrganizationId: publisherMembership
        ? (context?.activePublisher?.organizationId ?? null)
        : null,
      customerRole: customerMembership?.role ?? null,
      memberRole: customerMembership?.role ?? null,
      publisherRole: publisherMembership?.role ?? null,
      staffRole: staffMembership?.role ?? null,
      staffPermissions: normalizePermissions(staffMembership?.permissions),
    }) as DurableCurrentAuthority
  }
}
