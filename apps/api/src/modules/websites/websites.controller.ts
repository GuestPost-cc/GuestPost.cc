import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from "@nestjs/common"
import { WebsitesService } from "./websites.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { CreateWebsiteDto, UpdateWebsiteDto } from "./dto/websites.dto"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { PrismaService } from "../../common/prisma.service"
import { PublisherMembership } from "@guestpost/database"
import { NotFoundException } from "@nestjs/common"
import type { PublisherRole } from "@guestpost/shared"

@Controller("publishers/:publisherId/websites")
@UseGuards(MemberRolesGuard)
export class WebsitesController {
  constructor(
    private readonly websitesService: WebsitesService,
    private readonly prisma: PrismaService,
  ) {}

  private async resolvePublisherId(publisherIdParam: string, user: any): Promise<string> {
    if (publisherIdParam === "current") {
      const membership = await this.prisma.publisherMembership.findFirst({
        where: { userId: user.id },
      });
      if (!membership) {
        throw new NotFoundException("Publisher membership not found for user");
      }
      return membership.publisherId;
    }
    return publisherIdParam;
  }

   @Get()
   @MemberRoles("PUBLISHER_OWNER")
   async getWebsites(@Param("publisherId") publisherId: string, @CurrentUser() user: any) {
     const resolvedPublisherId = await this.resolvePublisherId(publisherId, user);
     return this.websitesService.getWebsites(resolvedPublisherId, user.organizationId);
   }

   @Post()
   @MemberRoles("PUBLISHER_OWNER")
   async createWebsite(
     @Param("publisherId") publisherId: string,
     @Body() body: CreateWebsiteDto,
     @CurrentUser() user: any
   ) {
     const resolvedPublisherId = await this.resolvePublisherId(publisherId, user);
     return this.websitesService.createWebsite(resolvedPublisherId, user.organizationId, body, user);
   }

   @Put(":id")
   @MemberRoles("PUBLISHER_OWNER")
   async updateWebsite(
     @Param("publisherId") publisherId: string,
     @Param("id") id: string,
     @Body() body: UpdateWebsiteDto,
     @CurrentUser() user: any
   ) {
     const resolvedPublisherId = await this.resolvePublisherId(publisherId, user);
     return this.websitesService.updateWebsite(resolvedPublisherId, user.organizationId, id, body, user);
   }

   @Delete(":id")
   @MemberRoles("PUBLISHER_OWNER")
   async deleteWebsite(
     @Param("publisherId") publisherId: string,
     @Param("id") id: string,
     @CurrentUser() user: any
   ) {
     const resolvedPublisherId = await this.resolvePublisherId(publisherId, user);
     return this.websitesService.deleteWebsite(resolvedPublisherId, user.organizationId, id, user);
   }

   @Post(":id/submit")
   @MemberRoles("PUBLISHER_OWNER")
   async submitForReview(
     @Param("publisherId") publisherId: string,
     @Param("id") id: string,
     @CurrentUser() user: any
   ) {
     const resolvedPublisherId = await this.resolvePublisherId(publisherId, user);
     return this.websitesService.submitForReview(resolvedPublisherId, user.organizationId, id, user);
   }
}