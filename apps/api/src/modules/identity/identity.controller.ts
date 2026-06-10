import { Controller, Get, Post, Delete, Body, Param, UseGuards } from "@nestjs/common"
import { IdentityService } from "./identity.service"
import { ActiveContextService } from "../active-context/active-context.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"
import { CreateOrganizationDto } from "./dto/create-organization.dto"
import { InviteMemberDto } from "./dto/invite-member.dto"
import { CreateTeamDto } from "./dto/create-team.dto"
import { PrismaService } from "../../common/prisma.service"
import { AuditService } from "../audit/audit.service"

@Controller("identity")
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly prisma: PrismaService,
    private readonly activeContext: ActiveContextService,
    private readonly audit: AuditService,
  ) {}

  @Get("me")
  getMe(@CurrentUser() user: any) {
    return {
      ...user,
      memberships: undefined,
      publisherMemberships: undefined,
      staffMemberships: undefined,
    }
  }

  // ─── Active Context ─────────────────────────────────────

  @Get("context")
  getContext(@CurrentUser() user: any) {
    return this.activeContext.get(user.id)
  }

  @Get("organizations")
  listOrganizations(@CurrentUser() user: any) {
    return this.identity.listOrganizations(user.id)
  }

  @Get("publishers")
  listPublishers(@CurrentUser() user: any) {
    return this.activeContext.listPublishers(user.id)
  }

  @Post("switch-organization")
  @UseGuards(ActorTypeGuard)
  @ActorType("CUSTOMER")
  async switchOrganization(
    @Body("organizationId") organizationId: string,
    @CurrentUser() user: any,
  ) {
    const prevOrgId = user.organizationId
    const ctx = await this.activeContext.setActiveOrganization(user.id, organizationId)

    await this.audit.log({
      action: "ORGANIZATION_SWITCHED",
      entityType: "ActiveContext",
      entityId: ctx.id,
      metadata: { from: prevOrgId, to: organizationId },
      userId: user.id,
      organizationId: organizationId,
    })

    return ctx
  }

  @Post("switch-publisher")
  @UseGuards(ActorTypeGuard)
  @ActorType("PUBLISHER")
  async switchPublisher(
    @Body("publisherId") publisherId: string,
    @CurrentUser() user: any,
  ) {
    const prevPubId = user.publisherId
    const ctx = await this.activeContext.setActivePublisher(user.id, publisherId)

    await this.audit.log({
      action: "PUBLISHER_SWITCHED",
      entityType: "ActiveContext",
      entityId: ctx.id,
      metadata: { from: prevPubId, to: publisherId },
      userId: user.id,
      organizationId: user.organizationId ?? null,
    })

    return ctx
  }

  // ─── Organization CRUD ──────────────────────────────────

  @Post("organizations")
  createOrganization(
    @Body() body: CreateOrganizationDto,
    @CurrentUser() user: any,
  ) {
    return this.identity.createOrganization({
      ...body,
      ownerId: user.id,
    })
  }

  @Post("organizations/:id/invite")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER")
  inviteMember(
    @Param("id") orgId: string,
    @CurrentUser() user: any,
    @Body() body: InviteMemberDto,
  ) {
    return this.identity.inviteMember(orgId, user.id, body.email, body.role)
  }

  @Delete("organizations/:id/members/:userId")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER")
  removeMember(
    @Param("id") orgId: string,
    @Param("userId") targetUserId: string,
    @CurrentUser() user: any,
  ) {
    return this.identity.removeMember(orgId, user.id, targetUserId)
  }

  @Post("organizations/:id/teams")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER")
  createTeam(
    @Param("id") orgId: string,
    @CurrentUser() user: any,
    @Body() body: CreateTeamDto,
  ) {
    return this.identity.createTeam(orgId, user.id, body.name)
  }

  @Get("organizations/:id/teams")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
  listTeams(@Param("id") orgId: string, @CurrentUser() user: any) {
    return this.identity.listTeams(orgId, user.id)
  }

  @Delete("organizations/:id/teams/:teamId")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER")
  deleteTeam(
    @Param("id") orgId: string,
    @Param("teamId") teamId: string,
    @CurrentUser() user: any,
  ) {
    return this.identity.deleteTeam(orgId, user.id, teamId)
  }

  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
  @Get("organizations/:id")
  getOrganization(@Param("id") orgId: string, @CurrentUser() user: any) {
    return this.identity.getOrganization(orgId, user.id)
  }

  @Get("organizations/:id/members")
  @UseGuards(MemberRolesGuard)
  @MemberRoles("OWNER", "MEMBER")
  listMembers(@Param("id") orgId: string, @CurrentUser() user: any) {
    return this.identity.listMembers(orgId, user.id)
  }
}
