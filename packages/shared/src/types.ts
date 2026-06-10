export type UserType = "CUSTOMER" | "PUBLISHER" | "STAFF"

export type CustomerRole = "OWNER" | "MEMBER"

export type PublisherRole = "PUBLISHER_OWNER" | "PUBLISHER_MEMBER"

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
  | "CONTENT_REQUESTED"
  | "CONTENT_CREATION"
  | "CONTENT_READY"
  | "CUSTOMER_REVIEW"
  | "APPROVED"
  | "PUBLISHED"
  | "VERIFIED"
  | "DELIVERED"
  | "SETTLED"
  | "COMPLETED"
  | "CANCELLED"
  | "REFUNDED"
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
  | "ITEM_ADDED"
  | "ITEM_REMOVED"
  | "PAYMENT_SUBMITTED"
  | "PAYMENT_CAPTURED"
  | "ORDER_ACCEPTED"
  | "CONTENT_REQUESTED"
  | "CONTENT_SUBMITTED"
  | "CONTENT_MARKED_READY"
  | "CONTENT_SUBMITTED_FOR_REVIEW"
  | "CONTENT_APPROVED"
  | "REVISION_REQUESTED"
  | "PUBLICATION_MARKED"
  | "VERIFIED_AUTO"
  | "VERIFIED_MANUAL"
  | "DELIVERY_CONFIRMED"
  | "DISPUTE_OPENED"
  | "DISPUTE_RESOLVED"
  | "ORDER_CANCELLED"
  | "REFUND_ISSUED"
  | "SETTLEMENT_CREATED"
  | "SETTLED"
  | "REFUNDED"

export type SettlementStatus = "PENDING" | "UNDER_REVIEW" | "CUSTOMER_APPROVED" | "ADMIN_APPROVED" | "RELEASED" | "CANCELLED"

export type DisputeStatus = "OPEN" | "UNDER_REVIEW" | "RESOLVED_REFUNDED" | "RESOLVED_REJECTED" | "RESOLVED_RESTORED"

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
