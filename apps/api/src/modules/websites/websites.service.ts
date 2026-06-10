import { Injectable, NotFoundException, BadRequestException, ForbiddenException } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"
import { CreateWebsiteDto, UpdateWebsiteDto } from "./dto/websites.dto"
import { ListingStatus, ListingType, ListingFulfillmentType } from "@guestpost/database"
import { normalizeDomain } from "../../common/domain"

@Injectable()
export class WebsitesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  async createWebsite(publisherId: string, organizationId: string, dto: CreateWebsiteDto, user: any) {
    const publisher = await this.prisma.publisher.findUnique({
      where: { id: publisherId },
    })
    
    if (!publisher) {
      throw new NotFoundException("Publisher not found")
    }
    if (publisher.organizationId !== organizationId) {
      throw new ForbiddenException("Publisher does not belong to this organization")
    }

    // Dedupe on the normalized domain, not the raw URL — www/trailing-slash
    // variants of an existing site must not create a second listing.
    const domain = normalizeDomain(dto.url)
    const existingWebsite = await this.prisma.website.findFirst({
      where: { OR: [{ url: dto.url }, { domain }] },
    })

    if (existingWebsite) {
      throw new BadRequestException(`Website with this domain already exists (${existingWebsite.url})`)
    }

    const website = await this.prisma.website.create({
      data: {
        url: dto.url,
        domain,
        country: dto.country,
        language: dto.language,
        category: dto.category,
        metrics: {
          dr: dto.domainRating,
          traffic: dto.monthlyTraffic,
        },
        publisherId,
      },
    })

    // Create associated MarketplaceListing with PENDING_REVIEW status
    const slug = dto.url.replace(/^https?:\/\//, "").replace(/[^a-z0-9]+/gi, "-").toLowerCase() + "-" + Date.now()

    await this.prisma.marketplaceListing.create({
      data: {
        title: dto.url,
        slug,
        description: `Guest posting placement on ${dto.url}`,
        type: ListingType.PUBLISHER_WEBSITE,
        status: ListingStatus.PENDING_REVIEW,
        fulfillmentType: ListingFulfillmentType.PUBLISHER,
        price: dto.price || 0,
        currency: "USD",
        domainRating: dto.domainRating,
        traffic: dto.monthlyTraffic,
        country: dto.country,
        language: dto.language,
        turnaroundDays: dto.turnaroundDays,
        websiteUrl: dto.url,
        publisherId,
        websiteId: website.id,
        organizationId,
      },
    })

    await this.audit.log({
      action: "WEBSITE_CREATED",
      entityType: "Website",
      entityId: website.id,
      metadata: { url: website.url },
      userId: user.id,
      organizationId,
    })

    return website
  }

  async updateWebsite(publisherId: string, organizationId: string, id: string, dto: UpdateWebsiteDto, user: any) {
    const publisher = await this.prisma.publisher.findUnique({ where: { id: publisherId } })
    if (!publisher || publisher.organizationId !== organizationId) {
      throw new NotFoundException("Publisher not found")
    }
    const website = await this.prisma.website.findFirst({
      where: { id, publisherId },
    })

    if (!website) {
      throw new NotFoundException("Website not found")
    }

    let domain = website.domain
    if (dto.url && dto.url !== website.url) {
      domain = normalizeDomain(dto.url)
      const duplicate = await this.prisma.website.findFirst({
        where: { id: { not: id }, OR: [{ url: dto.url }, { domain }] },
      })
      if (duplicate) {
        throw new BadRequestException(`Website with this domain already exists (${duplicate.url})`)
      }
    }

    const updated = await this.prisma.website.update({
      where: { id },
      data: {
        url: dto.url,
        domain,
        country: dto.country,
        language: dto.language,
        category: dto.category,
        metrics: {
          dr: dto.domainRating,
          traffic: dto.monthlyTraffic,
        },
      },
    })

    // Also update the pending listing if exists
    const listing = await this.prisma.marketplaceListing.findFirst({
      where: { websiteId: id, status: ListingStatus.PENDING_REVIEW },
    })

    if (listing) {
      await this.prisma.marketplaceListing.update({
        where: { id: listing.id },
        data: {
          title: dto.url,
          domainRating: dto.domainRating,
          traffic: dto.monthlyTraffic,
          country: dto.country,
          language: dto.language,
          price: dto.price,
          turnaroundDays: dto.turnaroundDays,
          websiteUrl: dto.url,
        },
      })
    }

    await this.audit.log({
      action: "WEBSITE_UPDATED",
      entityType: "Website",
      entityId: id,
      metadata: { url: dto.url },
      userId: user.id,
      organizationId,
    })

    return updated
  }

  async getWebsites(publisherId: string, organizationId: string) {
    const publisher = await this.prisma.publisher.findUnique({ where: { id: publisherId } })
    if (!publisher || publisher.organizationId !== organizationId) {
      throw new NotFoundException("Publisher not found")
    }
    return this.prisma.website.findMany({
      where: { publisherId },
      include: {
        marketplaceListings: {
          select: { status: true, price: true, turnaroundDays: true }
        }
      },
      orderBy: { createdAt: "desc" },
    })
  }

  async deleteWebsite(publisherId: string, organizationId: string, id: string, user: any) {
    const publisher = await this.prisma.publisher.findUnique({ where: { id: publisherId } })
    if (!publisher || publisher.organizationId !== organizationId) {
      throw new NotFoundException("Publisher not found")
    }
    const website = await this.prisma.website.findFirst({
      where: { id, publisherId },
    })

    if (!website) {
      throw new NotFoundException("Website not found")
    }

    // Instead of hard deleting, we archive the listings and pause the website
    await this.prisma.website.update({
      where: { id },
      data: { isActive: false },
    })

    await this.prisma.marketplaceListing.updateMany({
      where: { websiteId: id },
      data: { status: ListingStatus.ARCHIVED },
    })

    await this.audit.log({
      action: "WEBSITE_DELETED",
      entityType: "Website",
      entityId: id,
      metadata: { url: website.url },
      userId: user.id,
      organizationId,
    })

    return { success: true }
  }

  async submitForReview(publisherId: string, organizationId: string, id: string, user: any) {
    const publisher = await this.prisma.publisher.findUnique({ where: { id: publisherId } })
    if (!publisher || publisher.organizationId !== organizationId) {
      throw new NotFoundException("Publisher not found")
    }
    const website = await this.prisma.website.findFirst({
      where: { id, publisherId },
    })

    if (!website) {
      throw new NotFoundException("Website not found")
    }

    const listing = await this.prisma.marketplaceListing.findFirst({
      where: { websiteId: id, status: ListingStatus.DRAFT },
    })

    if (listing) {
      await this.prisma.marketplaceListing.update({
        where: { id: listing.id },
        data: { status: ListingStatus.PENDING_REVIEW },
      })
    }

    await this.audit.log({
      action: "WEBSITE_SUBMITTED_FOR_REVIEW",
      entityType: "Website",
      entityId: id,
      userId: user.id,
      organizationId,
    })

    return { success: true }
  }
}
