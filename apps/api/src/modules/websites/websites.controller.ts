import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards, NotFoundException } from "@nestjs/common"
import { WebsitesService } from "./websites.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { CreateWebsiteDto, UpdateWebsiteDto } from "./dto/websites.dto"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"

@Controller("publishers/:publisherId/websites")
@UseGuards(ActorTypeGuard, MemberRolesGuard)
@ActorType("PUBLISHER")
export class WebsitesController {
  constructor(
    private readonly websitesService: WebsitesService,
  ) {}

  private resolvePublisherId(publisherIdParam: string, user: any): string {
    if (publisherIdParam === "current") {
      if (!user.publisherId) {
        throw new NotFoundException("No active publisher context")
      }
      return user.publisherId
    }
    return publisherIdParam
  }

   @MemberRoles("PUBLISHER_OWNER")
   @Get()
   async getWebsites(@Param("publisherId") publisherId: string, @CurrentUser() user: any) {
     const resolvedPublisherId = this.resolvePublisherId(publisherId, user);
     return this.websitesService.getWebsites(resolvedPublisherId, user.publisherOrganizationId);
   }

   @MemberRoles("PUBLISHER_OWNER")
   @Post()
   async createWebsite(
     @Param("publisherId") publisherId: string,
     @Body() body: CreateWebsiteDto,
     @CurrentUser() user: any
   ) {
     const resolvedPublisherId = this.resolvePublisherId(publisherId, user);
     return this.websitesService.createWebsite(resolvedPublisherId, user.publisherOrganizationId, body, user);
   }

   @MemberRoles("PUBLISHER_OWNER")
   @Put(":id")
   async updateWebsite(
     @Param("publisherId") publisherId: string,
     @Param("id") id: string,
     @Body() body: UpdateWebsiteDto,
     @CurrentUser() user: any
   ) {
     const resolvedPublisherId = this.resolvePublisherId(publisherId, user);
     return this.websitesService.updateWebsite(resolvedPublisherId, user.publisherOrganizationId, id, body, user);
   }

   @MemberRoles("PUBLISHER_OWNER")
   @Delete(":id")
   async deleteWebsite(
     @Param("publisherId") publisherId: string,
     @Param("id") id: string,
     @CurrentUser() user: any
   ) {
     const resolvedPublisherId = this.resolvePublisherId(publisherId, user);
     return this.websitesService.deleteWebsite(resolvedPublisherId, user.publisherOrganizationId, id, user);
   }

   @MemberRoles("PUBLISHER_OWNER")
   @Post(":id/submit")
   async submitForReview(
     @Param("publisherId") publisherId: string,
     @Param("id") id: string,
     @CurrentUser() user: any
   ) {
     const resolvedPublisherId = this.resolvePublisherId(publisherId, user);
     return this.websitesService.submitForReview(resolvedPublisherId, user.publisherOrganizationId, id, user);
   }
}