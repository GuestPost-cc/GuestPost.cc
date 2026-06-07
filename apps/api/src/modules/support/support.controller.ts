import { Controller, Get, Post, Body, Param, UseGuards } from "@nestjs/common"
import { SupportService } from "./support.service"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { MemberRoles } from "../../common/decorators/member-roles.decorator"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"

@Controller("support")
@UseGuards(MemberRolesGuard)
@MemberRoles("OWNER", "MEMBER")
export class SupportController {
  constructor(private readonly support: SupportService) {}

  @Post("tickets")
  createTicket(
    @Body() body: { subject: string; description?: string },
    @CurrentUser() user: any,
  ) {
    return this.support.createTicket({
      subject: body.subject,
      description: body.description,
      userId: user.id,
      organizationId: user.organizationId,
    })
  }

  @Get("tickets")
  listTickets(@CurrentUser() user: any) {
    return this.support.listTickets(user.organizationId)
  }

  @Get("tickets/:id")
  getTicket(@Param("id") id: string, @CurrentUser() user: any) {
    return this.support.getTicket(id, user.organizationId)
  }

  @Post("tickets/:id/messages")
  addMessage(
    @Param("id") ticketId: string,
    @Body() body: { content: string },
    @CurrentUser() user: any,
  ) {
    return this.support.addMessage(ticketId, user.organizationId, {
      content: body.content,
      userId: user.id,
    })
  }
}
