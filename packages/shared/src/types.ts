export type UserType = "CUSTOMER" | "PUBLISHER" | "STAFF"

export type CustomerRole = "OWNER" | "MEMBER"

export type PublisherRole = "PUBLISHER_OWNER" | "PUBLISHER_MEMBER"

export type StaffRole = "SUPER_ADMIN" | "OPERATIONS" | "FINANCE"

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

export type TicketStatus =
  | "OPEN"
  | "IN_PROGRESS"
  | "WAITING_ON_CUSTOMER"
  | "RESOLVED"
  | "CLOSED"

export type CampaignStatus = "ACTIVE" | "PAUSED" | "COMPLETED" | "ARCHIVED"
export type WebsiteOwnershipType = "PUBLISHER" | "PLATFORM"

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
  | "VERIFICATION_ESCALATED"
  | "AUTO_ACCEPTED"
  | "REVIEW_REMINDER"
  | "DISPUTE_OPENED"
  | "DISPUTE_RESOLVED"
  | "ORDER_CANCELLED"
  | "REFUND_ISSUED"
  | "SETTLEMENT_CREATED"
  | "SETTLED"
  | "REFUNDED"

export type SettlementStatus =
  | "PENDING"
  | "UNDER_REVIEW"
  | "CUSTOMER_APPROVED"
  | "ADMIN_APPROVED"
  | "RELEASED"
  | "CANCELLED"

export type DisputeStatus =
  | "OPEN"
  | "UNDER_REVIEW"
  | "RESOLVED_REFUNDED"
  | "RESOLVED_REJECTED"
  | "RESOLVED_RESTORED"

export type WithdrawalStatus =
  | "PENDING"
  | "APPROVED"
  | "PROCESSING"
  | "COMPLETED"
  | "REJECTED"
  | "FAILED"
  | "REVERSED"

export type PublisherTier = "NEW" | "TRUSTED" | "VERIFIED"

export type VerificationStatus = "PENDING" | "VERIFIED" | "FAILED" | "DISPUTED"

export type DeliveryVerificationMethod =
  | "AUTO"
  | "MANUAL_ADMIN"
  | "CUSTOMER_MANUAL"

export type DeliveryAcceptedMethod = "CUSTOMER" | "AUTO_TIMEOUT"

export type VerificationOverrideReason =
  | "CRAWLER_BLOCKED"
  | "ROBOTS_TXT"
  | "LOGIN_REQUIRED"
  | "JS_RENDERING"
  | "TEMPORARY_FAILURE"
  | "OTHER"

export type SettlementReleasePolicy = "AUTO" | "MANUAL"

export type TransactionType =
  | "DEPOSIT"
  | "PURCHASE"
  | "REFUND"
  | "WITHDRAWAL"
  | "COMMISSION"
  | "ADJUSTMENT"
  | "RESERVATION"
  | "RELEASE"
