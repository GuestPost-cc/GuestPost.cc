/**
 * Marketplace and website lifecycle commands. These values intentionally
 * mirror the server enums without importing the database package into the
 * browser-safe API client.
 */
export type ModerationAction =
  | "SUBMIT_FOR_REVIEW"
  | "APPROVE"
  | "REQUEST_CHANGES"
  | "PAUSE"
  | "RESTORE"
  | "ARCHIVE"
  | "REOPEN"
  | "ALLOW_RESUBMISSION"
  | "DENY_RESUBMISSION"

export type ModerationScope = "LISTING" | "WEBSITE"

export type ModerationAuthority = "PUBLISHER" | "OPERATIONS" | "SUPER_ADMIN"

export type ModerationReasonCode =
  | "INITIAL_SUBMISSION"
  | "CORRECTIONS_COMPLETE"
  | "APPROVED_AFTER_REVIEW"
  | "INCOMPLETE_POLICY"
  | "INCOMPLETE_LISTING"
  | "CONTENT_QUALITY"
  | "PRICING_OR_SERVICE"
  | "DOMAIN_VERIFICATION"
  | "POLICY_VIOLATION"
  | "SECURITY_RISK"
  | "FRAUD_RISK"
  | "INVENTORY_UNAVAILABLE"
  | "OPERATIONAL_HOLD"
  | "PUBLISHER_REQUEST"
  | "ISSUE_RESOLVED"
  | "EMERGENCY_OVERRIDE"
  | "DUPLICATE_OR_INVALID"
  | "OTHER"
  | "LEGACY_ORIGIN_UNKNOWN"

export const MODERATION_ACTION_LABELS: Record<ModerationAction, string> = {
  SUBMIT_FOR_REVIEW: "Submit for review",
  APPROVE: "Approve",
  REQUEST_CHANGES: "Request changes",
  PAUSE: "Pause",
  RESTORE: "Restore",
  ARCHIVE: "Archive",
  REOPEN: "Reopen",
  ALLOW_RESUBMISSION: "Allow resubmission",
  DENY_RESUBMISSION: "Deny resubmission",
}

export const MODERATION_REASON_LABELS: Record<ModerationReasonCode, string> = {
  INITIAL_SUBMISSION: "Initial submission",
  CORRECTIONS_COMPLETE: "Requested corrections completed",
  APPROVED_AFTER_REVIEW: "Approved after review",
  INCOMPLETE_POLICY: "Placement policy is incomplete",
  INCOMPLETE_LISTING: "Listing details are incomplete",
  CONTENT_QUALITY: "Content quality requirements",
  PRICING_OR_SERVICE: "Pricing or service configuration",
  DOMAIN_VERIFICATION: "Domain verification issue",
  POLICY_VIOLATION: "Policy violation",
  SECURITY_RISK: "Security risk",
  FRAUD_RISK: "Fraud risk",
  INVENTORY_UNAVAILABLE: "Inventory unavailable",
  OPERATIONAL_HOLD: "Operational hold",
  PUBLISHER_REQUEST: "Publisher request",
  ISSUE_RESOLVED: "Issue resolved",
  EMERGENCY_OVERRIDE: "Emergency override",
  DUPLICATE_OR_INVALID: "Duplicate or invalid inventory",
  OTHER: "Other",
  LEGACY_ORIGIN_UNKNOWN: "Legacy action (reason unavailable)",
}

export function moderationActionLabel(action: ModerationAction): string {
  return MODERATION_ACTION_LABELS[action]
}

export function moderationReasonLabel(reason: ModerationReasonCode): string {
  return MODERATION_REASON_LABELS[reason]
}

export interface ActiveModerationDecision {
  action: ModerationAction
  authority: ModerationAuthority | null
  reasonCode: ModerationReasonCode | null
  publisherMessage: string | null
  resubmissionAllowed: boolean
  previousStatus?: string | null
  previousWebsiteActive?: boolean | null
}

export interface ModerationEventSummary {
  id: string
  scope: ModerationScope
  action: ModerationAction
  authority: ModerationAuthority
  reasonCode: ModerationReasonCode
  publisherMessage: string | null
  internalNote?: string | null
  resubmissionAllowed: boolean
  previousStatus?: string | null
  resultingStatus?: string | null
  previousModerationAction?: ModerationAction | null
  resultingModerationAction?: ModerationAction | null
  previousWebsiteActive?: boolean | null
  resultingWebsiteActive?: boolean | null
  actorUserId?: string | null
  actorStaffRole?: string | null
  actor?: { id: string; name: string | null; email?: string } | null
  createdAt: string
}

/**
 * A server-computed projection. Consumers must render allowedActions instead
 * of deriving permissions from status or role in the browser.
 */
export interface ModerationProjection {
  active: ActiveModerationDecision | null
  version: number
  allowedActions: ModerationAction[]
  history?: ModerationEventSummary[]
}

/**
 * Publisher responses deliberately cannot represent staff notes or actor
 * identity. Keeping this narrower than the staff projection makes an
 * accidental server-side field expansion visible as a contract review rather
 * than silently teaching publisher UI code about internal evidence.
 */
export type PublisherModerationEventSummary = Pick<
  ModerationEventSummary,
  | "id"
  | "scope"
  | "action"
  | "authority"
  | "reasonCode"
  | "publisherMessage"
  | "resubmissionAllowed"
  | "previousStatus"
  | "resultingStatus"
  | "previousModerationAction"
  | "resultingModerationAction"
  | "previousWebsiteActive"
  | "resultingWebsiteActive"
  | "createdAt"
>

export interface PublisherModerationProjection
  extends Omit<ModerationProjection, "history"> {
  history?: PublisherModerationEventSummary[]
}

/**
 * Staff command body. The UI supplies a reason for every staff action even
 * though legacy-compatible server paths may accept it as optional.
 */
export interface ModerationCommand {
  action: ModerationAction
  expectedVersion: number
  reasonCode: ModerationReasonCode
  publisherMessage?: string
  internalNote?: string
  force?: boolean
}

export interface ModerationCommandResponse {
  status?: string
  isActive?: boolean
  moderation?: ModerationProjection
  [key: string]: unknown
}
