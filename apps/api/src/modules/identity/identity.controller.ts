import { Controller, Get, Post, Body, Param, UseGuards, ForbiddenException, BadRequestException } from "@nestjs/common"
import { IdentityService } from "./identity.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"
import { CreateOrganizationDto } from "./dto/create-organization.dto"
import { InviteMemberDto } from "./dto/invite-member.dto"
import { CreateTeamDto } from "./dto/create-team.dto"
import { PrismaService } from "../../common/prisma.service"

@Controller("identity")
export class IdentityController {
  constructor(
    private readonly identity: IdentityService,
    private readonly prisma: PrismaService,
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

  @Post("me/set-staff")
  async setStaffRole(
    @CurrentUser() user: any,
    @Body("role") role: string,
  ) {
    if (process.env.NODE_ENV === "production" && !process.env.ALLOW_SELF_STAFF_ROLE) {
      throw new ForbiddenException("Self-service staff role assignment is disabled")
    }
    const validRoles = ["SUPER_ADMIN", "OPERATIONS", "FINANCE"]
    if (!validRoles.includes(role)) {
      throw new BadRequestException(`Invalid staff role: ${role}`)
    }
    const existing = await this.prisma.staffMembership.findUnique({
      where: { userId: user.id },
    })
    if (existing) {
      throw new ForbiddenException("Staff role already assigned")
    }
    await this.prisma.staffMembership.create({
      data: { userId: user.id, role: role as any },
    })
    await this.prisma.user.update({
      where: { id: user.id },
      data: { userType: "STAFF" },
    })
    return { message: `Staff role set to ${role}` }
  }

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

  @Get("organizations")
  listOrganizations(@CurrentUser() user: any) {
    return this.identity.listOrganizations(user.id)
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

  @Post("organizations/:id/teams")
  createTeam(
    @Param("id") orgId: string,
    @CurrentUser() user: any,
    @Body() body: CreateTeamDto,
  ) {
    return this.identity.createTeam(orgId, user.id, body.name)
  }

  @Get("organizations/:id/teams")
  listTeams(@Param("id") orgId: string, @CurrentUser() user: any) {
    return this.identity.listTeams(orgId, user.id)
  }
}
