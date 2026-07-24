import type { HttpClient } from "../client"

export interface PublisherWebsiteService {
  id: string
  serviceType: string
  price: number
  currency: string
  turnaroundDays: number
  revisionRounds: number
  warrantyDays?: number | null
  availability: "AVAILABLE" | "PAUSED" | "WAITLIST"
  version: number
}

export interface PublisherWebsiteListing {
  id: string
  title: string
  slug: string
  description: string
  status: string
  ownerType: "PUBLISHER"
  category?: { id: string; name: string; slug: string } | null
  categories?: Array<{ id: string; name: string; slug: string }>
  language?: string | null
  sportsGamingAllowed?: boolean | null
  pharmacyAllowed?: boolean | null
  cryptoAllowed?: boolean | null
  backlinkCount?: number | null
  linkType?: "DOFOLLOW" | "NOFOLLOW" | "SPONSORED" | "UGC" | null
  linkValidity?:
    | "PERMANENT"
    | "FIVE_YEARS"
    | "ONE_YEAR"
    | "SIX_MONTHS"
    | "THREE_MONTHS"
    | null
  googleNews?: boolean | null
  markedSponsored?: boolean | null
  foreignLanguageAllowed?: boolean | null
  services: PublisherWebsiteService[]
  createdAt?: string
  updatedAt?: string
}

export interface PublisherWebsiteResponse {
  id: string
  url: string
  domain?: string | null
  name?: string | null
  country?: string | null
  language?: string | null
  category?: string | null
  metrics?: { dr?: number; traffic?: number } | null
  domainMetrics?: WebsiteDomainMetrics
  isActive: boolean
  verificationStatus:
    | "PENDING_VERIFICATION"
    | "VERIFIED"
    | "VERIFICATION_FAILED"
    | "REVOKED"
  verifiedAt?: string | null
  verificationMethod?: "DNS_TXT" | "SUPER_ADMIN_OVERRIDE" | null
  verificationOverrideExpiresAt?: string | null
  verificationFailureReason?: string | null
  lastVerificationRequestAt?: string | null
  lastVerificationCheckAt?: string | null
  verificationInstructions?: {
    type: string
    host: string
    value: string
    note?: string
  } | null
  listing?: PublisherWebsiteListing | null
  marketplaceListings?: PublisherWebsiteListing[]
  seoIntegration?: any
  gscIntegration?: any
  gscAccountExists?: boolean
  websiteIntegrations?: any[]
}

export interface WebsiteMetricValue {
  value: number
  source: string
  status: "CURRENT" | "STALE" | "UNAVAILABLE"
  measuredAt: string
  collectedAt: string
  expiresAt?: string | null
}

export interface WebsiteDomainMetrics {
  ahrefsDomainRating?: WebsiteMetricValue
  ahrefsOrganicTraffic?: WebsiteMetricValue
  mozDomainAuthority?: WebsiteMetricValue
  openPageRank?: WebsiteMetricValue
  openPageRankGlobalRank?: WebsiteMetricValue
  openPageRankReferringDomains?: WebsiteMetricValue
}

export interface UpdateManualWebsiteMetricsInput {
  ahrefsOrganicTraffic: number
  ahrefsTrafficAsOf: string
  mozDomainAuthority: number
  mozDomainAuthorityAsOf: string
}

export interface CreatePublisherWebsiteInput {
  url: string
  name?: string
  country?: string
  language: string
  categoryIds: string[]
  listingTitle: string
  description: string
  sportsGamingAllowed: boolean
  pharmacyAllowed: boolean
  cryptoAllowed: boolean
  backlinkCount: number
  linkType: "DOFOLLOW" | "NOFOLLOW" | "SPONSORED" | "UGC"
  linkValidity:
    | "PERMANENT"
    | "FIVE_YEARS"
    | "ONE_YEAR"
    | "SIX_MONTHS"
    | "THREE_MONTHS"
  googleNews: boolean
  markedSponsored: boolean
  foreignLanguageAllowed: boolean
  manualMetrics: UpdateManualWebsiteMetricsInput
  initialService?: {
    serviceType: string
    price: number
    currency?: "USD" | "EUR" | "GBP"
    turnaroundDays: number
    revisionRounds?: number
    warrantyDays?: number
  }
}

export class PublishersService {
  constructor(private client: HttpClient) {}

  getWebsites(publisherId: string): Promise<PublisherWebsiteResponse[]> {
    return this.client.get<PublisherWebsiteResponse[]>(
      `/publishers/${publisherId}/websites`,
    )
  }

  getWebsite(
    publisherId: string,
    websiteId: string,
  ): Promise<PublisherWebsiteResponse> {
    return this.client.get<PublisherWebsiteResponse>(
      `/publishers/${publisherId}/websites/${websiteId}`,
    )
  }

  addWebsite(
    publisherId: string,
    data: CreatePublisherWebsiteInput,
  ): Promise<PublisherWebsiteResponse> {
    return this.client.post<PublisherWebsiteResponse>(
      `/publishers/${publisherId}/websites`,
      {
        json: data as unknown as Record<string, unknown>,
      },
    )
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

  updateManualWebsiteMetrics(
    publisherId: string,
    websiteId: string,
    data: UpdateManualWebsiteMetricsInput,
  ): Promise<WebsiteDomainMetrics> {
    return this.client.put<WebsiteDomainMetrics>(
      `/publishers/${publisherId}/websites/${websiteId}/metrics/manual`,
      { json: data as unknown as Record<string, unknown> },
    )
  }
}
