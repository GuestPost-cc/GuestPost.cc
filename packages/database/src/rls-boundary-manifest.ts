/**
 * Exhaustive ownership roots for the PostgreSQL RLS boundary.
 *
 * A model must appear exactly once. The API contract test compares this list
 * with schema.prisma, so adding a Prisma model without assigning an ownership
 * root fails CI. These roots are intentionally about data ownership, not
 * controller routing; policies may grant more than one audience through the
 * root (for example an Order belongs to a customer organization and is also
 * visible to the publisher fulfilling it).
 */
export const RLS_BOUNDARY_MODELS = {
  identity: [
    "User",
    "LegalAcceptance",
    "Session",
    "Account",
    "Verification",
    "ActiveContext",
    "NotificationPreference",
    "EmailSuppression",
    "MarketplaceFavorite",
    "MarketplaceSavedList",
    "MarketplaceSearchHistory",
    "MarketplaceRecommendation",
  ],
  authority: [
    "Organization",
    "Membership",
    "PublisherMembership",
    "StaffMembership",
  ],
  organization: ["BillingProfile", "Team", "Campaign", "ApiKey"],
  publisher: [
    "Publisher",
    "PublisherBalance",
    "Withdrawal",
    "PayoutMethod",
    "PublisherProviderAccount",
    "PublisherProfile",
  ],
  website: [
    "Website",
    "WebsiteMetric",
    "WebsiteMetricRevision",
    "WebsiteImportBatch",
    "WebsiteImportRow",
    "WebsiteSearchDaily",
    "WebsiteAnalyticsDaily",
    "WebsitePageSearchDaily",
  ],
  order: [
    "Order",
    "OrderItem",
    "OrderEvent",
    "Publication",
    "OrderDispute",
    "OrderCancellationRequest",
    "PublisherCompensation",
    "Settlement",
    "SettlementApproval",
    "FulfillmentAssignment",
    "OrderDeliveryVersion",
    "DeliveryVerificationEvidence",
    "DeliverySnapshot",
    "DeliveryFraudFlag",
    "DeliveryFraudHold",
    "DeliveryFraudFlagResolution",
    "DeliveryFraudFinding",
    "OrderReview",
    "ContentOrder",
    "OrderArticleVersion",
    "Revision",
    "Report",
    "PlatformRevenue",
  ],
  wallet: [
    "Wallet",
    "Transaction",
    "DepositAttempt",
    "DepositCreditRecovery",
    "DepositCreditEvidence",
    "PaymentProviderEvent",
    "PaymentDispute",
  ],
  payout: [
    "PayoutProvider",
    "PayoutExecution",
    "PayoutExecutionClaim",
    "WithdrawalAllocation",
    "PayoutWebhookEvent",
    "PayoutBatch",
  ],
  support: ["Ticket", "TicketMessage"],
  communication: [
    "Notification",
    "CommunicationEvent",
    "CommunicationDelivery",
    "FinancialDocument",
    "AuditLog",
  ],
  marketplace: [
    "MarketplaceCategory",
    "MarketplaceTag",
    "MarketplaceListing",
    "ModerationEvent",
    "MarketplaceListingCategory",
    "ListingService",
    "MarketplaceListingTag",
    "MarketplaceListingImage",
    "MarketplaceReview",
    "MarketplaceSavedListItem",
    "MarketplaceListingView",
    "MarketplaceListingClick",
    "MarketplaceFlag",
    "ListingFulfillmentRule",
  ],
  integration: [
    "ExternalAccount",
    "PublisherIntegration",
    "IntegrationSchedule",
    "IntegrationDiscovery",
    "WebsiteIntegration",
    "IntegrationSync",
  ],
  platform: ["DeliveryUrlClaimFence", "PlatformSettings"],
} as const

export type RlsBoundaryRoot = keyof typeof RLS_BOUNDARY_MODELS

export const RLS_MODEL_NAMES = Object.freeze(
  Object.values(RLS_BOUNDARY_MODELS).flat(),
)
