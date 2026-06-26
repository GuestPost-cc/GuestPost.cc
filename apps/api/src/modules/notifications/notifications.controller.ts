import { Controller, Get, Param, Patch, Post, Query } from "@nestjs/common"
import { CurrentUser } from "../../common/decorators/current-user.decorator"
import { NotificationsService } from "./notifications.service"

@Controller("notifications")
export class NotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  list(
    @CurrentUser() user: any,
    @Query("unreadOnly") unreadOnly?: string,
    @Query("type") type?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    return this.notifications.list(user.id, {
      unreadOnly: unreadOnly === "true",
      type,
      page: page ? parseInt(page, 10) || 1 : 1,
      limit: limit ? parseInt(limit, 10) || 20 : 20,
    })
  }

  @Get("unread-count")
  unreadCount(@CurrentUser() user: any) {
    return this.notifications.unreadCount(user.id)
  }

  @Patch(":id/read")
  markRead(@CurrentUser() user: any, @Param("id") id: string) {
    return this.notifications.markRead(user.id, id)
  }

  @Post("mark-all-read")
  markAllRead(@CurrentUser() user: any) {
    return this.notifications.markAllRead(user.id)
  }
}
