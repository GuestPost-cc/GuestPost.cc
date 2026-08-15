export type {
  ConnectResponse,
  DiscoverResourcesResponse,
  EnqueueDiscoveryResponse,
  IntegrationListResponse,
  IntegrationSummary,
  LinkPropertyResponse,
  SyncHistoryResponse,
  SyncJob,
  TriggerSyncResponse,
} from "@guestpost/integrations/client"
export {
  apiV1Url,
  resolveApiOrigin,
  resolveApiV1Url,
} from "./api-origin"
export type { ApiClientConfig, RequestOptions } from "./client"
export { ApiError, HttpClient } from "./client"
export type {
  DepositCommandIdentity,
  DepositIdempotencyState,
} from "./deposit-command"
export {
  bindDepositIdempotencyKey,
  depositErrorPresentation,
} from "./deposit-command"
export {
  isExactMoneyAtMost,
  normalizeExactNonNegativeMoney,
} from "./exact-money"
export { payoutErrorPresentation } from "./payout-command"
export type {
  AccountSuspensionMutationResponse,
  AccountSuspensionReason,
  AdminCancellationRequestResponse,
  AdminCommandCenterAction,
  AdminCommandCenterActionType,
  AdminCommandCenterPriority,
  AdminCommandCenterResponse,
  AdminDeliveryVerificationQueueItem,
  AdminFinancePipelineStage,
  AdminFinanceWorkbenchAction,
  AdminFinanceWorkbenchActionType,
  AdminFinanceWorkbenchPriority,
  AdminFinanceWorkbenchResponse,
  AdminMarketplaceListingDetail,
  AdminMarketplaceListingRow,
  AdminMarketplacePublisherSummary,
  AdminMarketplaceServiceRow,
  AdminOperationsWorkbenchAction,
  AdminOperationsWorkbenchActionType,
  AdminOperationsWorkbenchPriority,
  AdminOperationsWorkbenchResponse,
  AdminOpsStaffResponse,
  AdminOrderDetailResponse,
  AdminOrderFocus,
  AdminOrderListResponse,
  AdminOrderResponse,
  AdminOrderTimelineEvent,
  AdminPlatformListingServiceResponse,
  AdminPlatformWebsiteResponse,
  AdminSettlementEligibilityBlockerCode,
  AdminSettlementEligibilityResponse,
  AdminSettlementResponse,
  AdminStaffPerformanceItem,
  AdminStaffPerformanceResponse,
  AdminUserDetailResponse,
  AdminUserResponse,
  AdminWithdrawalResponse,
  DeliveryFraudDisposition,
  OperationsInboxFilters,
  OperationsInboxOrder,
  OperationsInboxResponse,
  OperationsInboxView,
  OperationsOrderDetail,
  WebsiteImportBatchResponse,
  WebsiteImportRowResponse,
  WebsiteImportRowStatus,
} from "./services/admin"
export { AdminService } from "./services/admin"
export type { ApiKeyCreatedResponse, ApiKeyResponse } from "./services/api-keys"
export { ApiKeysService } from "./services/api-keys"
export type { DepositCapabilityResponse } from "./services/billing"
export { BillingService } from "./services/billing"
export type { Campaign } from "./services/campaigns"
export { CampaignsService } from "./services/campaigns"
export type {
  BillingProfile,
  BillingProfileInput,
  OrganizationDetail,
  OrganizationMember,
  Team,
} from "./services/identity"
export { IdentityService } from "./services/identity"
export { IntegrationsService } from "./services/integrations"
export { integrationKeys } from "./services/integrations/keys"
export type {
  Category,
  ListingAttribution,
  ListingServiceOption,
  MarketplaceListing,
  PublicDomainMetrics,
  PublicDomainMetricValue,
  SearchFilters,
  SearchResult,
  UpdateMarketplaceListingInput,
} from "./services/marketplace"
export { MarketplaceService } from "./services/marketplace"
export type {
  NotificationItem,
  NotificationListResponse,
  NotificationPreference,
  NotificationPreferenceCategory,
} from "./services/notifications"
export { NotificationsService } from "./services/notifications"
export type {
  CancellationMutationData,
  CancellationPreviewResponse,
  CancellationReasonCode,
  CancellationRequestResponse,
  CancellationRequestStatus,
  CreateOrderData,
  DeliveryCapabilityBlockedReason,
  DeliveryProofAvailableResponse,
  DeliveryProofCapabilities,
  DeliveryProofResponse,
  DeliveryProofUnavailableResponse,
  DeliverySecurityReviewStatus,
  OrderItemData,
  OrderResponse,
  PublisherCompensationDecisionInput,
  StakeholderFinancialImpact,
  StakeholderTimelineEntry,
  StakeholderTimelineEntryKind,
  StakeholderTimelineEntrySeverity,
  StakeholderTimelineEntryStatus,
} from "./services/orders"
export { OrdersService } from "./services/orders"
export type {
  PublisherBalanceResponse,
  WithdrawalResponse,
} from "./services/publisher-payouts"
export { PublisherPayoutsService } from "./services/publisher-payouts"
export type {
  CreatePublisherWebsiteInput,
  PublisherWebsiteListing,
  PublisherWebsiteResponse,
  PublisherWebsiteService,
  UpdateManualWebsiteMetricsInput,
  WebsiteDomainMetrics,
  WebsiteMetricValue,
} from "./services/publishers"
export { PublishersService } from "./services/publishers"
export { ReportingService } from "./services/reporting"
export type { SettlementResponse } from "./services/settlements"
export { SettlementsService } from "./services/settlements"
export type {
  AddTicketMessageInput,
  CreateSupportTicketInput,
  CreateSupportTicketResponse,
  PublicSupportListFilters,
  PublicTicketStatusMutation,
  ReassignTicketInput,
  StaffSupportListFilters,
  StaffTicketDetail,
  StaffTicketIdentity,
  StaffTicketListItem,
  StaffTicketListResponse,
  StaffTicketPublisherIdentity,
  StaffTicketRequester,
  SupportListFilters,
  SupportMessageSender,
  SupportParty,
  SupportQueryScope,
  TicketAssignmentMutationResponse,
  TicketCapabilities,
  TicketDetail,
  TicketDetailQuery,
  TicketListItem,
  TicketListPage,
  TicketMessageActorSnapshot,
  TicketMessageAuthorEvidence,
  TicketMessageDto,
  TicketMessagePage,
  TicketMessageType,
  TicketMessageVisibility,
  TicketOrderSummary,
  TicketParticipantRole,
  TicketStatusMutationResponse,
} from "./services/support"
export { SupportService, supportKeys } from "./services/support"

import { type ApiClientConfig, HttpClient } from "./client"
import { AdminService } from "./services/admin"
import { ApiKeysService } from "./services/api-keys"
import { BillingService } from "./services/billing"
import { CampaignsService } from "./services/campaigns"
import { IdentityService } from "./services/identity"
import { IntegrationsService } from "./services/integrations"
import { MarketplaceService } from "./services/marketplace"
import { NotificationsService } from "./services/notifications"
import { OrdersService } from "./services/orders"
import { PublisherPayoutsService } from "./services/publisher-payouts"
import { PublishersService } from "./services/publishers"
import { ReportingService } from "./services/reporting"
import { SettlementsService } from "./services/settlements"
import { SupportService } from "./services/support"

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
  notifications: NotificationsService
  integrations: IntegrationsService
}

export {
  IntegrationOwnerType,
  IntegrationProvider,
  IntegrationStatus,
  IntegrationSyncStatus,
  IntegrationSyncTrigger,
  POLL_CONFIG,
} from "@guestpost/integrations/client"
export type { AuthErrorHandlerConfig } from "./auth-redirect"
// Phase 6.8 — re-export the shared 401-redirect helpers so apps can build
// the onAuthError callback without importing from a deep path. See
// ./auth-redirect.ts for the security contract (URL sanitization,
// idempotency guard, auth-endpoint skip).
export {
  buildAuthErrorHandler,
  sanitizeReturnTo,
} from "./auth-redirect"
export { isAuthEndpointPath } from "./client"

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
    notifications: new NotificationsService(client),
    integrations: new IntegrationsService(client),
  }
}
