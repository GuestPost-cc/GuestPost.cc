import type { HttpClient } from "../client"

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

  generateOrderReport(orderId: string) {
    return this.client.post<{ id: string; status: string }>(
      `/reports/orders/${orderId}/generate`,
    )
  }

  listReports() {
    return this.client.get<
      Array<{ id: string; type: string; status: string; createdAt: string }>
    >("/reports")
  }
}
