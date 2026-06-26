import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { CreateWebsiteDto, UpdateWebsiteDto } from "./dto/websites.dto"
import { WebsitesService } from "./websites.service"

@Controller("publishers/:publisherId/websites")
@UseGuards(ActorTypeGuard, MemberRolesGuard)
@ActorType("PUBLISHER")
export class WebsitesController {
  constructor(private readonly websitesService: WebsitesService) {}

  private resolvePublisherId(publisherIdParam: string, user: any): string {
    if (!user.publisherId) {
      throw new NotFoundException("No active publisher context")
    }
    // Only the caller's active publisher may be managed. Switching publishers
    // requires PublisherMembership (validated in /identity/switch-publisher),
    // so this blocks managing a sibling publisher in the same organization.
    if (
      publisherIdParam !== "current" &&
      publisherIdParam !== user.publisherId
    ) {
      throw new ForbiddenException("You can only manage your active publisher")
    }
    return user.publisherId
  }

  @MemberRoles("PUBLISHER_OWNER")
  @Get()
  async getWebsites(
    @Param("publisherId") publisherId: string,
    @CurrentUser() user: any,
  ) {
    const resolvedPublisherId = this.resolvePublisherId(publisherId, user)
    return this.websitesService.getWebsites(
      resolvedPublisherId,
      user.publisherOrganizationId,
    )
  }

  @MemberRoles("PUBLISHER_OWNER")
  @Post()
  async createWebsite(
    @Param("publisherId") publisherId: string,
    @Body() body: CreateWebsiteDto,
    @CurrentUser() user: any,
  ) {
    const resolvedPublisherId = this.resolvePublisherId(publisherId, user)
    return this.websitesService.createWebsite(
      resolvedPublisherId,
      user.publisherOrganizationId,
      body,
      user,
    )
  }

  @MemberRoles("PUBLISHER_OWNER")
  @Put(":id")
  async updateWebsite(
    @Param("publisherId") publisherId: string,
    @Param("id") id: string,
    @Body() body: UpdateWebsiteDto,
    @CurrentUser() user: any,
  ) {
    const resolvedPublisherId = this.resolvePublisherId(publisherId, user)
    return this.websitesService.updateWebsite(
      resolvedPublisherId,
      user.publisherOrganizationId,
      id,
      body,
      user,
    )
  }

  @MemberRoles("PUBLISHER_OWNER")
  @Delete(":id")
  async deleteWebsite(
    @Param("publisherId") publisherId: string,
    @Param("id") id: string,
    @CurrentUser() user: any,
  ) {
    const resolvedPublisherId = this.resolvePublisherId(publisherId, user)
    return this.websitesService.deleteWebsite(
      resolvedPublisherId,
      user.publisherOrganizationId,
      id,
      user,
    )
  }

  @MemberRoles("PUBLISHER_OWNER")
  @Post(":id/verify")
  async requestVerification(
    @Param("publisherId") publisherId: string,
    @Param("id") id: string,
    @CurrentUser() user: any,
  ) {
    const resolvedPublisherId = this.resolvePublisherId(publisherId, user)
    return this.websitesService.requestVerification(
      resolvedPublisherId,
      user.publisherOrganizationId,
      id,
      user,
    )
  }

  @MemberRoles("PUBLISHER_OWNER")
  @Post(":id/submit")
  async submitForReview(
    @Param("publisherId") publisherId: string,
    @Param("id") id: string,
    @CurrentUser() user: any,
  ) {
    const resolvedPublisherId = this.resolvePublisherId(publisherId, user)
    return this.websitesService.submitForReview(
      resolvedPublisherId,
      user.publisherOrganizationId,
      id,
      user,
    )
  }
}
