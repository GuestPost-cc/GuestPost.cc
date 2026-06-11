import { Injectable, NotFoundException, ForbiddenException, BadRequestException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { CustomerRole } from "@guestpost/shared"
import { invalidateAuthContext } from "../../common/auth-context-cache"

@Injectable()
export class IdentityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async findUserById(id: string) {
    return this.prisma.user.findUnique({
      where: { id },
      include: {
        memberships: { include: { organization: true } },
        publisherMemberships: true,
        staffMemberships: true,
      },
    })
  }

  async createOrganization(data: { name: string; slug: string; ownerId: string }) {
    const org = await this.prisma.organization.create({
      data: {
        name: data.name,
        slug: data.slug,
        memberships: {
          create: {
            userId: data.ownerId,
            role: "OWNER",
          },
        },
      },
    })

    await this.audit.log({
      action: "ORGANIZATION_CREATED",
      entityType: "Organization",
      entityId: org.id,
      metadata: { name: data.name, slug: data.slug },
      userId: data.ownerId,
      organizationId: org.id,
    })

    // The creator must see their new org immediately, not after the 30s
    // auth-context cache expires.
    invalidateAuthContext(data.ownerId)

    return org
  }

  // Self-serve publisher onboarding. Strictly limited to FRESH accounts:
  // a user with any existing customer or publisher membership must not be
  // silently re-typed — customers keep wallets/orders under CUSTOMER, and
  // existing publishers must not get a second publisher entity. Risk is
  // bounded by the layered controls downstream: tier starts NEW (maximum
  // withdrawal fraud-hold), listings require staff approval before they can
  // sell, and settlements require delivery + dual approval before any money
  // becomes withdrawable.
  async becomePublisher(userId: string, publisherName?: string) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException("User not found")
    if (user.userType === "STAFF") {
      throw new ForbiddenException("Staff accounts cannot become publishers")
    }

    const [customerMemberships, publisherMemberships] = await Promise.all([
      this.prisma.membership.count({ where: { userId } }),
      this.prisma.publisherMembership.count({ where: { userId } }),
    ])
    if (publisherMemberships > 0) {
      throw new BadRequestException("This account is already a publisher")
    }
    if (customerMemberships > 0) {
      throw new BadRequestException(
        "This account belongs to a customer organization. Use a separate account for publishing, or contact support.",
      )
    }

    const name = (publisherName ?? user.name ?? user.email).trim().slice(0, 120)

    const publisher = await this.prisma.$transaction(async (tx: any) => {
      const org = await tx.organization.create({
        data: { name: `Publisher org for ${user.email}`, slug: `pub-${userId.slice(0, 12)}` },
      })
      const created = await tx.publisher.create({
        data: {
          name,
          email: user.email,
          organizationId: org.id,
          // NEW = longest withdrawal hold; staff upgrade tier later (FINANCE)
          tier: "NEW",
        },
      })
      await tx.publisherMembership.create({
        data: { userId, publisherId: created.id, role: "PUBLISHER_OWNER" },
      })
      await tx.user.update({ where: { id: userId }, data: { userType: "PUBLISHER" } })

      await this.audit.log({
        action: "PUBLISHER_SELF_ONBOARDED",
        entityType: "Publisher",
        entityId: created.id,
        metadata: { userId, name, organizationId: org.id },
        userId,
        organizationId: org.id,
      }, tx)

      return created
    })

    invalidateAuthContext(userId)
    return { id: publisher.id, name: publisher.name, tier: publisher.tier }
  }

  async listOrganizations(userId: string) {
    const memberships = await this.prisma.membership.findMany({
      where: { userId },
      include: { organization: { select: { id: true, name: true, slug: true } } },
    })
    const activeCtx = await this.prisma.activeContext.findUnique({ where: { userId } })
    return memberships.map((m) => ({
      id: m.organization.id,
      name: m.organization.name,
      slug: m.organization.slug,
      role: m.role,
      isActive: m.organization.id === activeCtx?.activeOrganizationId,
    }))
  }

  async inviteMember(organizationId: string, callerUserId: string, email: string, role: CustomerRole) {
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId: callerUserId, role: { in: ["OWNER"] } },
    })

    if (!membership) throw new ForbiddenException("Only organization owners can invite members")

    const user = await this.prisma.user.findUnique({ where: { email } })
    if (!user) throw new NotFoundException("User not found")

    if (user.banned) {
      throw new ForbiddenException("Cannot invite a banned user")
    }

    const existing = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId } },
    })
    if (existing) throw new ForbiddenException("User is already a member of this organization")

    const invited = await this.prisma.membership.create({
      data: {
        userId: user.id,
        organizationId,
        role,
      },
    })
    invalidateAuthContext(user.id)

    await this.audit.log({
      action: "MEMBER_INVITED",
      entityType: "Membership",
      entityId: invited.id,
      metadata: { invitedUserId: user.id, email, role },
      userId: callerUserId,
      organizationId,
    })

    return invited
  }

  async removeMember(organizationId: string, callerUserId: string, targetUserId: string) {
    const callerMembership = await this.prisma.membership.findFirst({
      where: { organizationId, userId: callerUserId, role: { in: ["OWNER"] } },
    })
    if (!callerMembership) {
      throw new ForbiddenException("Only organization owners can remove members")
    }

    const targetMembership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: targetUserId, organizationId } },
    })
    if (!targetMembership) throw new NotFoundException("Member not found in this organization")

    if (targetMembership.role === "OWNER") {
      const ownerCount = await this.prisma.membership.count({
        where: { organizationId, role: "OWNER" },
      })
      if (ownerCount <= 1) {
        throw new ForbiddenException("Cannot remove the last owner of the organization")
      }
    }

    await this.prisma.membership.delete({ where: { id: targetMembership.id } })
    invalidateAuthContext(targetUserId)

    await this.audit.log({
      action: "MEMBER_REMOVED",
      entityType: "Membership",
      entityId: targetMembership.id,
      metadata: { removedUserId: targetUserId, removedRole: targetMembership.role },
      userId: callerUserId,
      organizationId,
    })
  }

  async createTeam(organizationId: string, userId: string, name: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId, role: { in: ["OWNER"] } },
    })

    if (!membership) throw new ForbiddenException("Only organization owners can create teams")

    const team = await this.prisma.team.create({ data: { name, organizationId } })

    await this.audit.log({
      action: "TEAM_CREATED",
      entityType: "Team",
      entityId: team.id,
      metadata: { name },
      userId,
      organizationId,
    })

    return team
  }

  async deleteTeam(organizationId: string, userId: string, teamId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId, role: { in: ["OWNER"] } },
    })
    if (!membership) throw new ForbiddenException("Only organization owners can delete teams")

    const team = await this.prisma.team.findFirst({
      where: { id: teamId, organizationId },
    })
    if (!team) throw new NotFoundException("Team not found")

    await this.prisma.team.delete({ where: { id: teamId } })

    await this.audit.log({
      action: "TEAM_DELETED",
      entityType: "Team",
      entityId: teamId,
      metadata: { name: team.name },
      userId,
      organizationId,
    })
  }

  async listTeams(organizationId: string, userId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId },
    })

    if (!membership) throw new ForbiddenException("You don't belong to this organization")

    return this.prisma.team.findMany({ where: { organizationId } })
  }

  async getOrganization(organizationId: string, userId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId },
    })
    if (!membership) throw new ForbiddenException("You don't belong to this organization")

    const org = await this.prisma.organization.findUnique({
      where: { id: organizationId },
      include: {
        _count: { select: { memberships: true, teams: true } },
      },
    })
    if (!org) throw new NotFoundException("Organization not found")

    return {
      id: org.id,
      name: org.name,
      slug: org.slug,
      plan: org.plan,
      createdAt: org.createdAt,
      memberCount: org._count.memberships,
      teamCount: org._count.teams,
      myRole: membership.role,
    }
  }

  async listMembers(organizationId: string, userId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId },
    })
    if (!membership) throw new ForbiddenException("You don't belong to this organization")

    const members = await this.prisma.membership.findMany({
      where: { organizationId },
      include: { user: { select: { id: true, name: true, email: true, image: true, banned: true, createdAt: true } } },
      orderBy: { createdAt: "asc" },
    })

    return members.map((m) => ({
      id: m.id,
      userId: m.user.id,
      name: m.user.name,
      email: m.user.email,
      image: m.user.image,
      role: m.role,
      banned: m.user.banned,
      joinedAt: m.createdAt,
    }))
  }
}
