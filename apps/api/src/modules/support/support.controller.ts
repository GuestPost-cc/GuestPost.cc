import { Controller, Get, Post, Patch, Body, Param, Query, UseGuards } from "@nestjs/common"
import { SupportService } from "./support.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"

// The support API is now multi-actor: CUSTOMER, PUBLISHER, and STAFF all
// read/write the same Ticket rows, but each sees a different slice based on
// the channel-aware visibility rules in SupportService. We split the
// endpoints by their guard so each group's role gate is explicit.

function buildActor(user: any): {
  userId: string
  kind: "CUSTOMER" | "PUBLISHER" | "STAFF"
  organizationId?: string | null
  publisherId?: string | null
  staffRole?: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null
} {
  if (user.userType === "STAFF") {
    return { userId: user.id, kind: "STAFF", staffRole: user.staffRole ?? null }
  }
  if (user.userType === "PUBLISHER") {
    return { userId: user.id, kind: "PUBLISHER", publisherId: user.publisherId ?? null }
  }
  return { userId: user.id, kind: "CUSTOMER", organizationId: user.organizationId ?? null }
}

@Controller("support")
export class SupportController {
  constructor(private readonly support: SupportService) {}

  // ── Customer endpoints (existing surface, channel snapshot happens
  //    server-side inside createTicket) ────────────────────────────────────
  @Post("tickets")
  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER")
  @MemberRoles("OWNER", "MEMBER")
  createTicket(
    @Body() body: { subject: string; description?: string; orderId?: string },
    @CurrentUser() user: any,
  ) {
    return this.support.createTicket({
      subject: body.subject,
      description: body.description,
      orderId: body.orderId,
      userId: user.id,
      organizationId: user.organizationId,
    })
  }

  // ── Multi-actor list / get / reply ───────────────────────────────────────
  // Same path; the service decides the visible slice via buildActor().
  @Get("tickets")
  @UseGuards(ActorTypeGuard)
  @ActorType("CUSTOMER", "PUBLISHER", "STAFF")
  listTickets(@CurrentUser() user: any, @Query("status") status?: string) {
    return this.support.listTickets(buildActor(user), { status })
  }

  @Get("tickets/:id")
  @UseGuards(ActorTypeGuard)
  @ActorType("CUSTOMER", "PUBLISHER", "STAFF")
  getTicket(@Param("id") id: string, @CurrentUser() user: any) {
    return this.support.getTicket(id, buildActor(user))
  }

  @Post("tickets/:id/messages")
  @UseGuards(ActorTypeGuard)
  @ActorType("CUSTOMER", "PUBLISHER", "STAFF")
  addMessage(
    @Param("id") ticketId: string,
    @Body() body: { content: string },
    @CurrentUser() user: any,
  ) {
    return this.support.addMessage(ticketId, buildActor(user), { content: body.content })
  }

  // ── Admin-only reassignment ──────────────────────────────────────────────
  @Patch("tickets/:id/reassign")
  @UseGuards(ActorTypeGuard, StaffRolesGuard)
  @ActorType("STAFF")
  @StaffRoles("SUPER_ADMIN")
  reassign(
    @Param("id") ticketId: string,
    @Body() body: { assignedToUserId?: string | null; assignedPublisherId?: string | null; reason?: string },
    @CurrentUser() user: any,
  ) {
    return this.support.reassignTicket(ticketId, body, { userId: user.id, staffRole: user.staffRole })
  }
}
