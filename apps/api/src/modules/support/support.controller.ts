import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common"
import { ActorType } from "../../common/decorators/actor-type.decorator"
import { CurrentAuthority } from "../../common/decorators/current-authority.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { StaffRoles } from "../../common/decorators/staff-roles.decorator"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"
import type { DurableCurrentAuthority } from "../auth/current-authority.service"
import { AddTicketMessageDto } from "./dto/add-ticket-message.dto"
import { CreateTicketDto } from "./dto/create-ticket.dto"
import { ListSupportTicketsQueryDto } from "./dto/list-support-tickets-query.dto"
import { ReassignTicketDto } from "./dto/reassign-ticket.dto"
import { UpdateExternalTicketStatusDto } from "./dto/update-external-ticket-status.dto"
import { type SupportActor, SupportService } from "./support.service"

// The support API is now multi-actor: CUSTOMER, PUBLISHER, and STAFF all
// read/write the same Ticket rows, but each sees a different slice based on
// the channel-aware visibility rules in SupportService. We split the
// endpoints by their guard so each group's role gate is explicit.

function buildActor(user: DurableCurrentAuthority): SupportActor {
  if (user.userType === "STAFF") {
    return { userId: user.id, kind: "STAFF", staffRole: user.staffRole ?? null }
  }
  if (user.userType === "PUBLISHER") {
    return {
      userId: user.id,
      kind: "PUBLISHER",
      publisherId: user.publisherId ?? null,
      publisherRole: user.publisherRole ?? null,
    }
  }
  return {
    userId: user.id,
    kind: "CUSTOMER",
    organizationId: user.organizationId ?? null,
    customerRole: user.customerRole ?? null,
  }
}

@Controller("support")
export class SupportController {
  constructor(private readonly support: SupportService) {}

  // Tenant and assignment routing is derived server-side from authenticated
  // membership and, when present, the locked order.
  @Post("tickets")
  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER", "PUBLISHER")
  @MemberRoles("OWNER", "MEMBER", "PUBLISHER_OWNER", "PUBLISHER_MEMBER")
  createTicket(
    @Body() body: CreateTicketDto,
    @CurrentAuthority() user: DurableCurrentAuthority,
  ) {
    return this.support.createTicket(buildActor(user), {
      clientRequestId: body.clientRequestId,
      subject: body.subject,
      description: body.description,
      orderId: body.orderId,
    })
  }

  // ── Multi-actor list / get / reply ───────────────────────────────────────
  // Same path; the service decides the visible slice via buildActor().
  @Get("tickets")
  @Header("Cache-Control", "private, no-store, no-cache, must-revalidate")
  @Header("Pragma", "no-cache")
  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER", "PUBLISHER")
  @MemberRoles("OWNER", "MEMBER", "PUBLISHER_OWNER", "PUBLISHER_MEMBER")
  listTickets(
    @CurrentAuthority() user: DurableCurrentAuthority,
    @Query() query: ListSupportTicketsQueryDto,
  ) {
    return this.support.listTickets(buildActor(user), query)
  }

  @Get("tickets/:id")
  @Header("Cache-Control", "private, no-store, no-cache, must-revalidate")
  @Header("Pragma", "no-cache")
  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER", "PUBLISHER")
  @MemberRoles("OWNER", "MEMBER", "PUBLISHER_OWNER", "PUBLISHER_MEMBER")
  getTicket(
    @Param("id") id: string,
    @CurrentAuthority() user: DurableCurrentAuthority,
    @Query("messageCursor") messageCursor?: string,
  ) {
    return this.support.getTicket(id, buildActor(user), { messageCursor })
  }

  @Post("tickets/:id/messages")
  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER", "PUBLISHER")
  @MemberRoles("OWNER", "MEMBER", "PUBLISHER_OWNER", "PUBLISHER_MEMBER")
  addMessage(
    @Param("id") ticketId: string,
    @Body() body: AddTicketMessageDto,
    @CurrentAuthority() user: DurableCurrentAuthority,
  ) {
    return this.support.addMessage(ticketId, buildActor(user), {
      content: body.content,
      clientMessageId: body.clientMessageId,
      visibility: body.visibility,
    })
  }

  @Patch("tickets/:id/status")
  @UseGuards(ActorTypeGuard, MemberRolesGuard)
  @ActorType("CUSTOMER", "PUBLISHER")
  @MemberRoles("OWNER", "MEMBER", "PUBLISHER_OWNER", "PUBLISHER_MEMBER")
  updateStatus(
    @Param("id") ticketId: string,
    @Body() body: UpdateExternalTicketStatusDto,
    @CurrentAuthority() user: DurableCurrentAuthority,
  ) {
    return this.support.updateExternalStatus(
      ticketId,
      body.status,
      buildActor(user),
    )
  }

  // ── Admin-only reassignment ──────────────────────────────────────────────
  @Patch("tickets/:id/reassign")
  @UseGuards(ActorTypeGuard, StaffRolesGuard)
  @ActorType("STAFF")
  @StaffRoles("SUPER_ADMIN")
  reassign(
    @Param("id") ticketId: string,
    @Body() body: ReassignTicketDto,
    @CurrentAuthority() user: DurableCurrentAuthority,
  ) {
    return this.support.reassignTicket(ticketId, body, buildActor(user))
  }
}
