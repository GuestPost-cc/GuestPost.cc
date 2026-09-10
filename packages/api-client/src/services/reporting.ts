import type { HttpClient } from "../client"

export interface ReportListItem {
  id: string
  type: string
  format: "pdf" | "csv"
  exportedAt: string | null
  createdAt: string
  updatedAt: string
  order: { id: string; title: string | null; type: string; status: string }
}

export interface ReportListPage {
  items: ReportListItem[]
  total: number
  take: number
  skip: number
}

export class ReportingService {
  constructor(private client: HttpClient) {}

  getOrderReport(orderId: string) {
    return this.client.get<{
      id: string
      url?: string
      data?: Record<string, unknown>
    }>(`/reports/orders/${orderId}`)
  }

  getCampaignReport(campaignId: string) {
    return this.client.get<{
      id: string
      url?: string
      data?: Record<string, unknown>
    }>(`/reports/campaigns/${campaignId}`)
  }

  generateOrderReport(orderId: string, format: "pdf" | "csv" = "pdf") {
    return this.client.post<{ message: string }>(
      `/reports/orders/${orderId}/generate`,
      { json: { format } },
    )
  }

  listReports(params: { take?: number; skip?: number } = {}) {
    return this.client.get<ReportListPage>("/reports", { params })
  }

  getReport(id: string) {
    return this.client.get<ReportListItem & { data: unknown }>(`/reports/${id}`)
  }
}
