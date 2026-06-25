import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common"
import { invalidateAuthContext } from "../../common/auth-context-cache"
import type { PrismaService } from "../../common/prisma.service"

@Injectable()
export class ActiveContextService {
  constructor(private readonly prisma: PrismaService) {}

  async getOrCreate(userId: string) {
    let ctx = await this.prisma.activeContext.findUnique({ where: { userId } })
    if (ctx) return ctx

    const user = await this.prisma.user.findUnique({ where: { id: userId } })
    if (!user) throw new NotFoundException("User not found")

    let activeOrganizationId: string | null = null
    let activePublisherId: string | null = null

    if (user.userType === "CUSTOMER") {
      const membership = await this.prisma.membership.findFirst({
        where: { userId, status: "ACTIVE" },
        orderBy: { createdAt: "asc" },
      })
      activeOrganizationId = membership?.organizationId ?? null
    } else if (user.userType === "PUBLISHER") {
      const pubMembership = await this.prisma.publisherMembership.findFirst({
        where: { userId },
        orderBy: { createdAt: "asc" },
      })
      activePublisherId = pubMembership?.publisherId ?? null
    }

    ctx = await this.prisma.activeContext.create({
      data: { userId, activeOrganizationId, activePublisherId },
    })
    return ctx
  }

  async get(userId: string) {
    return this.prisma.activeContext.findUnique({ where: { userId } })
  }

  async setActiveOrganization(userId: string, organizationId: string) {
    // Cannot switch into an org you haven't accepted yet
    const membership = await this.prisma.membership.findUnique({
      where: { userId_organizationId: { userId, organizationId } },
    })
    if (membership?.status !== "ACTIVE") {
      throw new ForbiddenException(
        "You are not an active member of this organization",
      )
    }

    const ctx = await this.prisma.activeContext.upsert({
      where: { userId },
      create: { userId, activeOrganizationId: organizationId },
      update: { activeOrganizationId: organizationId },
    })
    invalidateAuthContext(userId)
    return ctx
  }

  async setActivePublisher(userId: string, publisherId: string) {
    const membership = await this.prisma.publisherMembership.findFirst({
      where: { userId, publisherId },
    })
    if (!membership)
      throw new ForbiddenException("User does not belong to this publisher")

    const ctx = await this.prisma.activeContext.upsert({
      where: { userId },
      create: { userId, activePublisherId: publisherId },
      update: { activePublisherId: publisherId },
    })
    invalidateAuthContext(userId)
    return ctx
  }

  async resolveRoles(
    userId: string,
    organizationId: string | null,
    publisherId: string | null,
  ) {
    let customerRole: string | null = null
    let publisherRole: string | null = null
    let staffRole: string | null = null

    if (organizationId) {
      const membership = await this.prisma.membership.findUnique({
        where: { userId_organizationId: { userId, organizationId } },
      })
      customerRole = membership?.role ?? null
    }

    if (publisherId) {
      const pubMembership = await this.prisma.publisherMembership.findFirst({
        where: { userId, publisherId },
      })
      publisherRole = pubMembership?.role ?? null
    }

    const staffMembership = await this.prisma.staffMembership.findUnique({
      where: { userId },
    })
    staffRole = staffMembership?.role ?? null

    return { customerRole, memberRole: customerRole, publisherRole, staffRole }
  }

  async listOrganizations(userId: string) {
    return this.prisma.membership.findMany({
      where: { userId },
      include: {
        organization: { select: { id: true, name: true, slug: true } },
      },
    })
  }

  async listPublishers(userId: string) {
    return this.prisma.publisherMembership.findMany({
      where: { userId },
      include: { publisher: { select: { id: true, name: true } } },
    })
  }

  async clearOrganization(userId: string) {
    const ctx = await this.prisma.activeContext.upsert({
      where: { userId },
      create: { userId, activeOrganizationId: null },
      update: { activeOrganizationId: null },
    })
    invalidateAuthContext(userId)
    return ctx
  }

  async clearPublisher(userId: string) {
    const ctx = await this.prisma.activeContext.upsert({
      where: { userId },
      create: { userId, activePublisherId: null },
      update: { activePublisherId: null },
    })
    invalidateAuthContext(userId)
    return ctx
  }
}
