export type UserType = "CUSTOMER" | "PUBLISHER" | "STAFF"

export type CustomerRole = "OWNER" | "MEMBER"

export type PublisherRole = "PUBLISHER_OWNER"

export type StaffRole = "SUPER_ADMIN" | "OPERATIONS" | "FINANCE"

// Deprecated: kept for migration compatibility
export type UserRole = "OWNER" | "MANAGER" | "SEO_SPECIALIST" | "CLIENT_VIEWER" | "PUBLISHER" | "ADMIN"
// Deprecated: kept for migration compatibility
export type MemberRole = "OWNER" | "MANAGER" | "SEO_SPECIALIST" | "CLIENT_VIEWER"

export type OrderStatus =
  | "DRAFT"
  | "PENDING_PAYMENT"
  | "PAID"
  | "SUBMITTED"
  | "ACCEPTED"
  | "ASSIGNED"
  | "CONTENT_REQUESTED"
  | "CONTENT_CREATION"
  | "CONTENT_READY"
  | "REVIEW"
  | "UNDER_REVIEW"
  | "OUTREACH"
  | "PUBLISHED"
  | "VERIFIED"
  | "DELIVERED"
  | "SETTLED"
  | "COMPLETED"
  | "CANCELLED"
  | "REFUNDED"
  | "REJECTED"
  | "DISPUTED"

export type ServiceType =
  | "GUEST_POST"
  | "NICHE_EDIT"
  | "EDITORIAL_LINK"
  | "OUTREACH_LINK"
  | "LOCAL_CITATION"
  | "FOUNDATION_LINK"
  | "BLOG_ARTICLE"
  | "SEO_CONTENT"

export type PaymentStatus = "PENDING" | "PAID" | "REFUNDED" | "FAILED"

export type TicketStatus = "OPEN" | "IN_PROGRESS" | "WAITING_ON_CUSTOMER" | "RESOLVED" | "CLOSED"

export type CampaignStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED"

export type OrderEventType =
  | "ORDER_CREATED"
  | "PAYMENT_RECEIVED"
  | "ASSIGNED"
  | "CONTENT_SUBMITTED"
  | "CONTENT_APPROVED"
  | "PUBLISHED"
  | "VERIFIED"
  | "UNDER_REVIEW"
  | "SETTLED"
  | "COMPLETED"
  | "CANCELLED"
  | "REFUNDED"
  | "DISPUTED"
  | "REJECTED"

export type SettlementStatus = "PENDING" | "UNDER_REVIEW" | "APPROVED" | "PAID" | "DISPUTED" | "CANCELLED"

export type WithdrawalStatus = "PENDING" | "APPROVED" | "PROCESSING" | "COMPLETED" | "REJECTED"

export type PublisherTier = "NEW" | "TRUSTED" | "VERIFIED"

export type VerificationStatus = "PENDING" | "VERIFIED" | "FAILED" | "DISPUTED"

export type TransactionType =
  | "DEPOSIT"
  | "PURCHASE"
  | "REFUND"
  | "WITHDRAWAL"
  | "COMMISSION"
  | "ADJUSTMENT"
  | "RESERVATION"
  | "RELEASE"
