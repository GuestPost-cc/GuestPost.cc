export { HttpClient, ApiError, setToken, clearToken, getToken } from "./client"
export type { ApiClientConfig, RequestOptions } from "./client"
export { IdentityService } from "./services/identity"
export { MarketplaceService } from "./services/marketplace"
export { CampaignsService } from "./services/campaigns"
export { BillingService } from "./services/billing"
export { OrdersService } from "./services/orders"
export type { CreateOrderData, OrderItemData, OrderResponse } from "./services/orders"
export { SettlementsService } from "./services/settlements"
export type { SettlementResponse } from "./services/settlements"
export { PublisherPayoutsService } from "./services/publisher-payouts"
export type { PublisherBalanceResponse, WithdrawalResponse } from "./services/publisher-payouts"
export { ApiKeysService } from "./services/api-keys"
export type { ApiKeyResponse, ApiKeyCreatedResponse } from "./services/api-keys"
export { AdminService } from "./services/admin"
export type {
  AdminUserResponse,
  AdminOrderResponse,
  AdminSettlementResponse,
  AdminWithdrawalResponse,
} from "./services/admin"
export { ReportingService } from "./services/reporting"
export { SupportService } from "./services/support"
export { PublishersService } from "./services/publishers"

import { HttpClient, type ApiClientConfig } from "./client"
import { IdentityService } from "./services/identity"
import { MarketplaceService } from "./services/marketplace"
import { CampaignsService } from "./services/campaigns"
import { BillingService } from "./services/billing"
import { OrdersService } from "./services/orders"
import { SettlementsService } from "./services/settlements"
import { PublisherPayoutsService } from "./services/publisher-payouts"
import { ApiKeysService } from "./services/api-keys"
import { AdminService } from "./services/admin"
import { ReportingService } from "./services/reporting"
import { SupportService } from "./services/support"
import { PublishersService } from "./services/publishers"

export interface GuestPostApi {
  client: HttpClient
  identity: IdentityService
  marketplace: MarketplaceService
  campaigns: CampaignsService
  billing: BillingService
  orders: OrdersService
  settlements: SettlementsService
  publisherPayouts: PublisherPayoutsService
  apiKeys: ApiKeysService
  admin: AdminService
  reporting: ReportingService
  support: SupportService
  publishers: PublishersService
}

export function createApiClient(config: ApiClientConfig): GuestPostApi {
  const client = new HttpClient(config)
  return {
    client,
    identity: new IdentityService(client),
    marketplace: new MarketplaceService(client),
    campaigns: new CampaignsService(client),
    billing: new BillingService(client),
    orders: new OrdersService(client),
    settlements: new SettlementsService(client),
    publisherPayouts: new PublisherPayoutsService(client),
    apiKeys: new ApiKeysService(client),
    admin: new AdminService(client),
    reporting: new ReportingService(client),
    support: new SupportService(client),
    publishers: new PublishersService(client),
  }
}
