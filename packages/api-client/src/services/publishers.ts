import type { HttpClient } from "../client"

export class PublishersService {
  constructor(private client: HttpClient) {}

  getWebsites(publisherId: string): Promise<any[]> {
    return this.client.get(`/publishers/${publisherId}/websites`)
  }

  addWebsite(publisherId: string, data: any): Promise<any> {
    return this.client.post(`/publishers/${publisherId}/websites`, {
      json: data,
    })
  }

  updateWebsite(
    publisherId: string,
    websiteId: string,
    data: any,
  ): Promise<any> {
    return this.client.put(`/publishers/${publisherId}/websites/${websiteId}`, {
      json: data,
    })
  }

  deleteWebsite(publisherId: string, websiteId: string): Promise<any> {
    return this.client.delete(
      `/publishers/${publisherId}/websites/${websiteId}`,
    )
  }

  submitForReview(publisherId: string, websiteId: string): Promise<any> {
    return this.client.post(
      `/publishers/${publisherId}/websites/${websiteId}/submit`,
    )
  }

  verifyWebsite(publisherId: string, websiteId: string): Promise<any> {
    return this.client.post(
      `/publishers/${publisherId}/websites/${websiteId}/verify`,
    )
  }
}
