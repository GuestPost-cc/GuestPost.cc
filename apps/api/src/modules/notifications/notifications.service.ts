import { Injectable, NotFoundException } from "@nestjs/common"
import type { PrismaService } from "../../common/prisma.service"

// Read surface over Notification rows written by the worker and services.
// Strictly self-scoped: every query filters by the authenticated userId —
// a notification id from another user is a 404, never a leak.
@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(
    userId: string,
    params: {
      unreadOnly?: boolean
      type?: string
      page?: number
      limit?: number
    },
  ) {
    const page = Math.max(params.page ?? 1, 1)
    const limit = Math.min(Math.max(params.limit ?? 20, 1), 100)
    const where: any = { userId }
    if (params.unreadOnly) where.read = false
    if (params.type) where.type = params.type

    const [items, total, unreadCount] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: (page - 1) * limit,
      }),
      this.prisma.notification.count({ where }),
      this.prisma.notification.count({ where: { userId, read: false } }),
    ])

    return {
      items,
      total,
      unreadCount,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    }
  }

  async unreadCount(userId: string) {
    const count = await this.prisma.notification.count({
      where: { userId, read: false },
    })
    return { count }
  }

  async markRead(userId: string, id: string) {
    const result = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { read: true },
    })
    if (result.count === 0)
      throw new NotFoundException("Notification not found")
    return { ok: true }
  }

  async markAllRead(userId: string) {
    const result = await this.prisma.notification.updateMany({
      where: { userId, read: false },
      data: { read: true },
    })
    return { ok: true, marked: result.count }
  }
}
