import { z } from "zod"

export const NOTIFICATION_CATEGORIES = [
  "SECURITY",
  "ACCOUNT",
  "ORDERS",
  "BILLING",
  "SETTLEMENTS",
  "PAYOUTS",
  "MARKETPLACE",
  "SUPPORT",
  "STAFF_ALERTS",
  "PRODUCT",
] as const

export const NOTIFICATION_CHANNELS = ["IN_APP", "EMAIL"] as const
export const ACTOR_RECIPIENT_POLICIES = [
  "EXCLUDE",
  "INCLUDE_IF_LISTED",
] as const
export const NOTIFICATION_SEVERITIES = [
  "INFO",
  "SUCCESS",
  "WARNING",
  "CRITICAL",
] as const

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number]
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number]
export type ActorRecipientPolicy = (typeof ACTOR_RECIPIENT_POLICIES)[number]
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number]

export const COMMUNICATION_EVENT_TYPES = [
  "ACCOUNT_ORGANIZATION_INVITED",
  "MARKETPLACE_LISTING_APPROVED",
  "MARKETPLACE_LISTING_REJECTED",
  "MARKETPLACE_WAITLIST_AVAILABLE",
  "BILLING_DEPOSIT_SUCCEEDED",
  "BILLING_DEPOSIT_FAILED",
  "BILLING_DEPOSIT_EXPIRED",
  "BILLING_DEPOSIT_REFUNDED",
  "BILLING_DEPOSIT_DISPUTED",
  "ORDER_CREATED",
  "ORDER_PAYMENT_CAPTURED",
  "ORDER_SUBMITTED",
  "ORDER_REVIEW_REMINDER",
  "ORDER_ACCEPTED",
  "ORDER_CONTENT_READY",
  "ORDER_REVISION_REQUESTED",
  "ORDER_CONTENT_APPROVED",
  "ORDER_PUBLISHED",
  "ORDER_VERIFIED",
  "ORDER_DELIVERED",
  "ORDER_COMPLETED",
  "ORDER_CANCELLED",
  "ORDER_REFUNDED",
  "ORDER_CANCELLATION_REQUESTED",
  "ORDER_CANCELLATION_RESPONDED",
  "ORDER_CANCELLATION_RESOLVED",
  "ORDER_DISPUTE_OPENED",
  "ORDER_DISPUTE_RESOLVED",
  "ORDER_SECURITY_REVIEW_DECIDED",
  "SETTLEMENT_CREATED",
  "SETTLEMENT_RELEASED",
  "PUBLISHER_COMPENSATION_DECIDED",
  "PUBLISHER_DEBT_CREATED",
  "PUBLISHER_TIER_CHANGED",
  "PAYOUT_WITHDRAWAL_REQUESTED",
  "PAYOUT_WITHDRAWAL_APPROVED",
  "PAYOUT_WITHDRAWAL_PROCESSING",
  "PAYOUT_WITHDRAWAL_COMPLETED",
  "PAYOUT_WITHDRAWAL_FAILED",
  "PAYOUT_WITHDRAWAL_REVERSED",
  "SUPPORT_PUBLIC_REPLY",
  "SUPPORT_INTERNAL_NOTE",
  "SUPPORT_STATUS_CHANGED",
  "STAFF_RECONCILIATION_ALERT",
  "STAFF_HIGH_VALUE_ORDER",
  "STAFF_HIGH_VALUE_ORDER_COMPLETED",
  "STAFF_HIGH_VALUE_DEPOSIT",
  "STAFF_HIGH_VALUE_REFUND",
  "STAFF_HIGH_VALUE_SETTLEMENT",
  "STAFF_DEPOSIT_FAILED",
  "STAFF_DISPUTE_OPENED",
  "STAFF_PUBLISHER_DEBT_CREATED",
  "STAFF_PUBLISHER_TIER_CHANGED",
  "STAFF_WALLET_LOW_BALANCE",
  "STAFF_CHARGEBACK_ALERT",
  "STAFF_FRAUD_ALERT",
] as const

export type CommunicationEventType = (typeof COMMUNICATION_EVENT_TYPES)[number]

export interface CommunicationEventPolicy {
  category: NotificationCategory
  severity: NotificationSeverity
  defaultChannels: readonly NotificationChannel[]
  // Required channels ignore a user's opt-out. Keep this list deliberately
  // narrow: security, money receipts, deadlines, and staff risk controls.
  requiredChannels?: readonly NotificationChannel[]
  // Actors are excluded from activity broadcasts by default. A receipt can
  // retain an actor only when an authorized resolver independently listed the
  // same user in recipientUserIds; this never adds a recipient.
  actorRecipientPolicy?: ActorRecipientPolicy
}

const both = ["IN_APP", "EMAIL"] as const
const inApp = ["IN_APP"] as const

export const COMMUNICATION_EVENT_POLICIES: Record<
  CommunicationEventType,
  CommunicationEventPolicy
> = {
  ACCOUNT_ORGANIZATION_INVITED: {
    category: "ACCOUNT",
    severity: "INFO",
    defaultChannels: both,
  },
  MARKETPLACE_LISTING_APPROVED: {
    category: "MARKETPLACE",
    severity: "SUCCESS",
    defaultChannels: both,
  },
  MARKETPLACE_LISTING_REJECTED: {
    category: "MARKETPLACE",
    severity: "WARNING",
    defaultChannels: both,
  },
  MARKETPLACE_WAITLIST_AVAILABLE: {
    category: "MARKETPLACE",
    severity: "INFO",
    defaultChannels: inApp,
  },
  BILLING_DEPOSIT_SUCCEEDED: {
    category: "BILLING",
    severity: "SUCCESS",
    defaultChannels: both,
    requiredChannels: both,
  },
  BILLING_DEPOSIT_FAILED: {
    category: "BILLING",
    severity: "WARNING",
    defaultChannels: both,
  },
  BILLING_DEPOSIT_EXPIRED: {
    category: "BILLING",
    severity: "INFO",
    defaultChannels: both,
  },
  BILLING_DEPOSIT_REFUNDED: {
    category: "BILLING",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
  },
  BILLING_DEPOSIT_DISPUTED: {
    category: "BILLING",
    severity: "CRITICAL",
    defaultChannels: both,
    requiredChannels: both,
  },
  ORDER_CREATED: {
    category: "ORDERS",
    severity: "INFO",
    defaultChannels: both,
  },
  ORDER_PAYMENT_CAPTURED: {
    category: "BILLING",
    severity: "SUCCESS",
    defaultChannels: both,
    requiredChannels: both,
    actorRecipientPolicy: "INCLUDE_IF_LISTED",
  },
  ORDER_SUBMITTED: {
    category: "ORDERS",
    severity: "SUCCESS",
    defaultChannels: both,
  },
  ORDER_REVIEW_REMINDER: {
    category: "ORDERS",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
  },
  ORDER_ACCEPTED: {
    category: "ORDERS",
    severity: "SUCCESS",
    defaultChannels: both,
  },
  ORDER_CONTENT_READY: {
    category: "ORDERS",
    severity: "INFO",
    defaultChannels: both,
  },
  ORDER_REVISION_REQUESTED: {
    category: "ORDERS",
    severity: "WARNING",
    defaultChannels: both,
  },
  ORDER_CONTENT_APPROVED: {
    category: "ORDERS",
    severity: "SUCCESS",
    defaultChannels: both,
  },
  ORDER_PUBLISHED: {
    category: "ORDERS",
    severity: "SUCCESS",
    defaultChannels: both,
  },
  ORDER_VERIFIED: {
    category: "ORDERS",
    severity: "SUCCESS",
    defaultChannels: both,
  },
  ORDER_DELIVERED: {
    category: "ORDERS",
    severity: "SUCCESS",
    defaultChannels: both,
  },
  ORDER_COMPLETED: {
    category: "ORDERS",
    severity: "SUCCESS",
    defaultChannels: both,
  },
  ORDER_CANCELLED: {
    category: "ORDERS",
    severity: "WARNING",
    defaultChannels: both,
  },
  ORDER_REFUNDED: {
    category: "BILLING",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
    actorRecipientPolicy: "INCLUDE_IF_LISTED",
  },
  ORDER_CANCELLATION_REQUESTED: {
    category: "ORDERS",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: ["IN_APP"],
  },
  ORDER_CANCELLATION_RESPONDED: {
    category: "ORDERS",
    severity: "INFO",
    defaultChannels: both,
  },
  ORDER_CANCELLATION_RESOLVED: {
    category: "ORDERS",
    severity: "WARNING",
    defaultChannels: both,
  },
  ORDER_DISPUTE_OPENED: {
    category: "ORDERS",
    severity: "CRITICAL",
    defaultChannels: both,
    requiredChannels: ["IN_APP"],
  },
  ORDER_DISPUTE_RESOLVED: {
    category: "ORDERS",
    severity: "WARNING",
    defaultChannels: both,
  },
  ORDER_SECURITY_REVIEW_DECIDED: {
    category: "ORDERS",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
  },
  SETTLEMENT_CREATED: {
    category: "SETTLEMENTS",
    severity: "INFO",
    defaultChannels: both,
  },
  SETTLEMENT_RELEASED: {
    category: "SETTLEMENTS",
    severity: "SUCCESS",
    defaultChannels: both,
    requiredChannels: both,
  },
  PUBLISHER_COMPENSATION_DECIDED: {
    category: "BILLING",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
    actorRecipientPolicy: "INCLUDE_IF_LISTED",
  },
  PUBLISHER_DEBT_CREATED: {
    category: "SETTLEMENTS",
    severity: "CRITICAL",
    defaultChannels: both,
    requiredChannels: both,
  },
  PUBLISHER_TIER_CHANGED: {
    category: "MARKETPLACE",
    severity: "INFO",
    defaultChannels: both,
  },
  PAYOUT_WITHDRAWAL_REQUESTED: {
    category: "PAYOUTS",
    severity: "INFO",
    defaultChannels: both,
  },
  PAYOUT_WITHDRAWAL_APPROVED: {
    category: "PAYOUTS",
    severity: "SUCCESS",
    defaultChannels: both,
  },
  PAYOUT_WITHDRAWAL_PROCESSING: {
    category: "PAYOUTS",
    severity: "INFO",
    defaultChannels: both,
  },
  PAYOUT_WITHDRAWAL_COMPLETED: {
    category: "PAYOUTS",
    severity: "SUCCESS",
    defaultChannels: both,
    requiredChannels: both,
  },
  PAYOUT_WITHDRAWAL_FAILED: {
    category: "PAYOUTS",
    severity: "CRITICAL",
    defaultChannels: both,
    requiredChannels: both,
  },
  PAYOUT_WITHDRAWAL_REVERSED: {
    category: "PAYOUTS",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
  },
  SUPPORT_PUBLIC_REPLY: {
    category: "SUPPORT",
    severity: "INFO",
    defaultChannels: both,
  },
  SUPPORT_INTERNAL_NOTE: {
    category: "SUPPORT",
    severity: "INFO",
    defaultChannels: inApp,
  },
  SUPPORT_STATUS_CHANGED: {
    category: "SUPPORT",
    severity: "INFO",
    defaultChannels: both,
  },
  STAFF_RECONCILIATION_ALERT: {
    category: "STAFF_ALERTS",
    severity: "CRITICAL",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_HIGH_VALUE_ORDER: {
    category: "STAFF_ALERTS",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_HIGH_VALUE_ORDER_COMPLETED: {
    category: "STAFF_ALERTS",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_HIGH_VALUE_DEPOSIT: {
    category: "STAFF_ALERTS",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_HIGH_VALUE_REFUND: {
    category: "STAFF_ALERTS",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_HIGH_VALUE_SETTLEMENT: {
    category: "STAFF_ALERTS",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_DEPOSIT_FAILED: {
    category: "STAFF_ALERTS",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_DISPUTE_OPENED: {
    category: "STAFF_ALERTS",
    severity: "CRITICAL",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_PUBLISHER_DEBT_CREATED: {
    category: "STAFF_ALERTS",
    severity: "CRITICAL",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_PUBLISHER_TIER_CHANGED: {
    category: "STAFF_ALERTS",
    severity: "INFO",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_WALLET_LOW_BALANCE: {
    category: "STAFF_ALERTS",
    severity: "WARNING",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_CHARGEBACK_ALERT: {
    category: "STAFF_ALERTS",
    severity: "CRITICAL",
    defaultChannels: both,
    requiredChannels: both,
  },
  STAFF_FRAUD_ALERT: {
    category: "STAFF_ALERTS",
    severity: "CRITICAL",
    defaultChannels: both,
    requiredChannels: both,
  },
}

const safePathSchema = z
  .string()
  .max(512)
  .refine(
    (value) =>
      value.startsWith("/") &&
      !value.startsWith("//") &&
      !/[\u0000-\u001f\u007f]/.test(value),
    "Action path must be a safe application-relative path",
  )

export const communicationEventInputSchema = z.object({
  type: z.enum(COMMUNICATION_EVENT_TYPES),
  aggregateType: z.string().trim().min(1).max(64),
  aggregateId: z.string().trim().min(1).max(191),
  organizationId: z.string().trim().min(1).max(191).nullable().optional(),
  title: z.string().trim().min(1).max(160),
  message: z.string().trim().min(1).max(2000),
  actionPath: safePathSchema.nullable().optional(),
  payload: z.record(z.string(), z.unknown()).nullable().optional(),
  dedupKey: z
    .string()
    .trim()
    .min(1)
    .max(256)
    .regex(/^[A-Za-z0-9:._-]+$/),
  recipientUserIds: z.array(z.string().trim().min(1).max(191)).max(500),
  actorUserId: z.string().trim().min(1).max(191).nullable().optional(),
})

export type CommunicationEventInput = z.infer<
  typeof communicationEventInputSchema
>

export const emailDeliveryJobSchema = z.object({
  deliveryId: z.string().trim().min(1).max(191),
})

export function isRequiredCommunicationChannel(
  eventType: CommunicationEventType,
  channel: NotificationChannel,
): boolean {
  return (
    COMMUNICATION_EVENT_POLICIES[eventType].requiredChannels?.includes(
      channel,
    ) ?? false
  )
}

export function defaultCommunicationChannels(
  eventType: CommunicationEventType,
): readonly NotificationChannel[] {
  return COMMUNICATION_EVENT_POLICIES[eventType].defaultChannels
}

export function shouldDeliverCommunicationChannel(
  eventType: CommunicationEventType,
  channel: NotificationChannel,
  storedPreference: boolean | undefined,
): boolean {
  return (
    storedPreference !== false ||
    isRequiredCommunicationChannel(eventType, channel)
  )
}

export function notificationPreferenceDefaults(): Array<{
  category: NotificationCategory
  inApp: boolean
  email: boolean
  mutable: boolean
}> {
  return NOTIFICATION_CATEGORIES.map((category) => ({
    category,
    inApp: true,
    email: category !== "PRODUCT",
    mutable: category !== "SECURITY" && category !== "STAFF_ALERTS",
  }))
}
