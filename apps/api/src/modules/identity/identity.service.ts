import { Injectable, NotFoundException, ForbiddenException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { CustomerRole } from "@guestpost/shared"

@Injectable()
export class IdentityService {
  constructor(private readonly prisma: PrismaService) {}

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
    return this.prisma.organization.create({
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
  }

  async listOrganizations(userId: string) {
    return this.prisma.organization.findMany({
      where: { memberships: { some: { userId } } },
    })
  }

  async inviteMember(organizationId: string, userId: string, email: string, role: CustomerRole) {
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId, role: { in: ["OWNER"] } },
    })

    if (!membership) throw new ForbiddenException("Only organization owners can invite members")

    const user = await this.prisma.user.findUnique({ where: { email } })
    if (!user) throw new NotFoundException("User not found")

    const existing = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId: user.id, organizationId } },
    })
    if (existing) throw new ForbiddenException("User is already a member of this organization")

    return this.prisma.membership.create({
      data: {
        userId: user.id,
        organizationId,
        role,
      },
    })
  }

  async createTeam(organizationId: string, userId: string, name: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId, role: { in: ["OWNER"] } },
    })

    if (!membership) throw new ForbiddenException("Only organization owners can create teams")

    return this.prisma.team.create({ data: { name, organizationId } })
  }

  async listTeams(organizationId: string, userId: string) {
    const membership = await this.prisma.membership.findFirst({
      where: { organizationId, userId },
    })

    if (!membership) throw new ForbiddenException("You don't belong to this organization")

    return this.prisma.team.findMany({ where: { organizationId } })
  }
}
