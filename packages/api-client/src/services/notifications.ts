import type { HttpClient } from "../client"

export interface NotificationItem {
  id: string
  type: string
  message: string
  read: boolean
  organizationId: string | null
  createdAt: string
}

export interface NotificationListResponse {
  items: NotificationItem[]
  total: number
  unreadCount: number
  page: number
  limit: number
  totalPages: number
}

export class NotificationsService {
  constructor(private client: HttpClient) {}

  list(params?: {
    unreadOnly?: boolean
    type?: string
    page?: number
    limit?: number
  }) {
    return this.client.get<NotificationListResponse>("/notifications", {
      params: {
        ...(params?.unreadOnly ? { unreadOnly: "true" } : {}),
        ...(params?.type ? { type: params.type } : {}),
        ...(params?.page ? { page: params.page } : {}),
        ...(params?.limit ? { limit: params.limit } : {}),
      } as Record<string, string | number>,
    })
  }

  unreadCount() {
    return this.client.get<{ count: number }>("/notifications/unread-count")
  }

  markRead(id: string) {
    return this.client.patch<{ ok: boolean }>(`/notifications/${id}/read`)
  }

  markAllRead() {
    return this.client.post<{ ok: boolean; marked: number }>(
      "/notifications/mark-all-read",
    )
  }
}
