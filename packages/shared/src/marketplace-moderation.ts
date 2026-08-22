/**
 * Marketplace moderation is deliberately separate from listing lifecycle.
 *
 * These functions are pure so API commands, projections, and UI tests share a
 * fail-closed transition matrix without pulling Prisma into browser bundles.
 * Authorization still has to be re-checked by the command service while its
 * target rows are locked.
 */

export const MODERATION_ACTIONS = [
  "SUBMIT_FOR_REVIEW",
  "APPROVE",
  "REQUEST_CHANGES",
  "PAUSE",
  "RESTORE",
  "ARCHIVE",
  "REOPEN",
  "ALLOW_RESUBMISSION",
  "DENY_RESUBMISSION",
] as const

export type ModerationActionValue = (typeof MODERATION_ACTIONS)[number]

export const STAFF_LISTING_MODERATION_ACTIONS = [
  "APPROVE",
  "REQUEST_CHANGES",
  "PAUSE",
  "RESTORE",
  "ARCHIVE",
  "REOPEN",
  "ALLOW_RESUBMISSION",
  "DENY_RESUBMISSION",
] as const satisfies readonly ModerationActionValue[]

export const STAFF_WEBSITE_MODERATION_ACTIONS = [
  "PAUSE",
  "RESTORE",
  "ARCHIVE",
  "REOPEN",
] as const satisfies readonly ModerationActionValue[]

export const MODERATION_REASON_CODES = [
  "INITIAL_SUBMISSION",
  "CORRECTIONS_COMPLETE",
  "APPROVED_AFTER_REVIEW",
  "INCOMPLETE_POLICY",
  "INCOMPLETE_LISTING",
  "CONTENT_QUALITY",
  "PRICING_OR_SERVICE",
  "DOMAIN_VERIFICATION",
  "POLICY_VIOLATION",
  "SECURITY_RISK",
  "FRAUD_RISK",
  "INVENTORY_UNAVAILABLE",
  "OPERATIONAL_HOLD",
  "PUBLISHER_REQUEST",
  "ISSUE_RESOLVED",
  "EMERGENCY_OVERRIDE",
  "DUPLICATE_OR_INVALID",
  "OTHER",
  "LEGACY_ORIGIN_UNKNOWN",
] as const

export type ModerationReasonCodeValue = (typeof MODERATION_REASON_CODES)[number]
export type ModerationAuthorityValue =
  | "PUBLISHER"
  | "OPERATIONS"
  | "SUPER_ADMIN"
export type MarketplaceOwnerTypeValue = "PUBLISHER" | "PLATFORM"
export type ListingStatusValue =
  | "DRAFT"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "PAUSED"
  | "ARCHIVED"

export interface ModerationFields {
  activeModerationAction?: ModerationActionValue | null
  activeModerationAuthority?: ModerationAuthorityValue | null
  activeModerationReasonCode?: ModerationReasonCodeValue | null
  activeModerationMessage?: string | null
  moderationVersion?: number
}

export interface ListingModerationSnapshot extends ModerationFields {
  status: ListingStatusValue
  ownerType: MarketplaceOwnerTypeValue
  activeModerationPreviousStatus?: ListingStatusValue | null
  moderationResubmissionAllowed?: boolean
  managedByUserId?: string | null
}

export interface WebsiteModerationSnapshot extends ModerationFields {
  isActive: boolean
  ownershipType: MarketplaceOwnerTypeValue
  activeModerationPreviousActive?: boolean | null
  managedByUserId?: string | null
}

export interface StaffModerationActor {
  id: string
  staffRole?: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null
}

export const LEGACY_SUPER_ADMIN_LISTING_PAUSE_MESSAGE =
  "This listing was paused before moderation history was introduced. A GuestPost Super Admin must review it before restoration."
export const LEGACY_SUPER_ADMIN_WEBSITE_PAUSE_MESSAGE =
  "This website was inactive before moderation history was introduced. A GuestPost Super Admin must review it before restoration."

const LEGACY_OPERATIONS_LISTING_PAUSE_MESSAGE =
  "This listing was paused before moderation history was introduced. GuestPost Operations must review it before restoration."
const LEGACY_OPERATIONS_WEBSITE_PAUSE_MESSAGE =
  "This website was inactive before moderation history was introduced. GuestPost Operations must review it before restoration."

interface ModerationPublisherMessageEvent {
  id: string
  listingId: string | null
  websiteId: string | null
  scope: "LISTING" | "WEBSITE"
  action: ModerationActionValue
  authority: ModerationAuthorityValue
  reasonCode: ModerationReasonCodeValue
  publisherMessage: string | null
  actorUserId: string | null
  actorStaffRole: "SUPER_ADMIN" | "OPERATIONS" | "FINANCE" | null
  previousStatus: ListingStatusValue | null
  resultingStatus: ListingStatusValue | null
  previousWebsiteActive: boolean | null
  resultingWebsiteActive: boolean | null
  resubmissionAllowed: boolean
}

/**
 * Corrects presentation of the exact system-imported legacy pause rows whose
 * stored copy named Operations even though their authority is Super Admin.
 * The underlying ModerationEvent remains immutable; every tuple and the
 * deterministic migration ID must match before presentation is corrected.
 */
export function projectModerationPublisherMessage(
  event: ModerationPublisherMessageEvent,
): string | null {
  const exactLegacyImport =
    event.action === "PAUSE" &&
    event.authority === "SUPER_ADMIN" &&
    event.reasonCode === "LEGACY_ORIGIN_UNKNOWN" &&
    event.actorUserId === null &&
    event.actorStaffRole === null &&
    event.resubmissionAllowed === false

  if (
    exactLegacyImport &&
    event.scope === "LISTING" &&
    event.listingId !== null &&
    event.websiteId === null &&
    event.id === `legacy-listing-${event.listingId}-paused` &&
    event.publisherMessage === LEGACY_OPERATIONS_LISTING_PAUSE_MESSAGE &&
    event.previousStatus === null &&
    event.resultingStatus === "PAUSED" &&
    event.previousWebsiteActive === null &&
    event.resultingWebsiteActive === null
  ) {
    return LEGACY_SUPER_ADMIN_LISTING_PAUSE_MESSAGE
  }

  if (
    exactLegacyImport &&
    event.scope === "WEBSITE" &&
    event.websiteId !== null &&
    event.listingId === null &&
    event.id === `legacy-website-${event.websiteId}-inactive` &&
    event.publisherMessage === LEGACY_OPERATIONS_WEBSITE_PAUSE_MESSAGE &&
    event.previousStatus === null &&
    event.resultingStatus === null &&
    event.previousWebsiteActive === null &&
    event.resultingWebsiteActive === false
  ) {
    return LEGACY_SUPER_ADMIN_WEBSITE_PAUSE_MESSAGE
  }

  return event.publisherMessage
}

export function staffCanModerateMarketplaceTarget(
  target: {
    ownershipType?: MarketplaceOwnerTypeValue
    ownerType?: MarketplaceOwnerTypeValue
    managedByUserId?: string | null
  },
  actor: StaffModerationActor,
): boolean {
  if (actor.staffRole === "SUPER_ADMIN") return true
  if (actor.staffRole !== "OPERATIONS") return false
  const ownershipType = target.ownershipType ?? target.ownerType
  return ownershipType === "PUBLISHER" || target.managedByUserId === actor.id
}

function actorCanChangeActiveStaffDecision(
  target: ModerationFields,
  actor: StaffModerationActor,
): boolean {
  if (actor.staffRole === "SUPER_ADMIN") return true
  return target.activeModerationAuthority === "OPERATIONS"
}

export function getStaffListingModerationActions(
  listing: ListingModerationSnapshot,
  actor: StaffModerationActor,
): ModerationActionValue[] {
  if (!staffCanModerateMarketplaceTarget(listing, actor)) return []

  const actions: ModerationActionValue[] = []
  const canChangeActive = actorCanChangeActiveStaffDecision(listing, actor)

  if (
    listing.status === "PENDING_REVIEW" ||
    (listing.status === "DRAFT" && listing.ownerType === "PLATFORM")
  ) {
    actions.push("APPROVE")
  }
  if (listing.status === "PENDING_REVIEW" || listing.status === "APPROVED") {
    actions.push("REQUEST_CHANGES")
  }
  if (listing.status === "APPROVED") actions.push("PAUSE")

  if (
    listing.status === "PAUSED" &&
    listing.activeModerationAction === "PAUSE" &&
    listing.activeModerationPreviousStatus === "APPROVED" &&
    listing.activeModerationAuthority !== "PUBLISHER" &&
    canChangeActive
  ) {
    actions.push("RESTORE")
  }

  if (
    listing.activeModerationAction &&
    ["REQUEST_CHANGES", "ARCHIVE"].includes(listing.activeModerationAction) &&
    listing.activeModerationAuthority !== "PUBLISHER" &&
    canChangeActive
  ) {
    actions.push(
      listing.moderationResubmissionAllowed
        ? "DENY_RESUBMISSION"
        : "ALLOW_RESUBMISSION",
    )
  }

  if (actor.staffRole === "SUPER_ADMIN") {
    if (listing.status !== "ARCHIVED") actions.push("ARCHIVE")
    if (
      listing.status === "ARCHIVED" ||
      (listing.status === "PAUSED" &&
        listing.activeModerationPreviousStatus == null)
    ) {
      actions.push("REOPEN")
    }
  }

  return [...new Set(actions)]
}

export function getPublisherListingLifecycleActions(
  listing: ListingModerationSnapshot,
): ModerationActionValue[] {
  if (listing.ownerType !== "PUBLISHER") return []

  const activeStaffDecision =
    listing.activeModerationAuthority === "OPERATIONS" ||
    listing.activeModerationAuthority === "SUPER_ADMIN"

  if (activeStaffDecision) {
    const explicitlyResubmittable =
      (listing.status === "REJECTED" &&
        listing.activeModerationAction === "REQUEST_CHANGES") ||
      (listing.status === "ARCHIVED" &&
        listing.activeModerationAction === "ARCHIVE")
    return explicitlyResubmittable && listing.moderationResubmissionAllowed
      ? ["SUBMIT_FOR_REVIEW"]
      : []
  }

  const actions: ModerationActionValue[] = []
  if (
    listing.status === "DRAFT" ||
    (listing.status === "ARCHIVED" &&
      listing.activeModerationAuthority === "PUBLISHER" &&
      listing.activeModerationAction === "ARCHIVE" &&
      listing.moderationResubmissionAllowed)
  ) {
    actions.push("SUBMIT_FOR_REVIEW")
  }
  if (listing.status === "APPROVED") actions.push("PAUSE")
  if (
    listing.status === "PAUSED" &&
    listing.activeModerationAuthority === "PUBLISHER" &&
    listing.activeModerationAction === "PAUSE" &&
    listing.activeModerationPreviousStatus === "APPROVED"
  ) {
    actions.push("RESTORE")
  }
  if (listing.status !== "ARCHIVED") actions.push("ARCHIVE")
  return actions
}

export function getStaffWebsiteModerationActions(
  website: WebsiteModerationSnapshot,
  actor: StaffModerationActor,
): ModerationActionValue[] {
  if (!staffCanModerateMarketplaceTarget(website, actor)) return []

  const actions: ModerationActionValue[] = []
  const canChangeActive = actorCanChangeActiveStaffDecision(website, actor)
  if (website.isActive) actions.push("PAUSE")
  if (
    !website.isActive &&
    website.activeModerationAction === "PAUSE" &&
    website.activeModerationPreviousActive === true &&
    website.activeModerationAuthority !== "PUBLISHER" &&
    canChangeActive
  ) {
    actions.push("RESTORE")
  }
  if (actor.staffRole === "SUPER_ADMIN") {
    if (website.activeModerationAction !== "ARCHIVE") actions.push("ARCHIVE")
    if (
      website.activeModerationAction === "ARCHIVE" ||
      (!website.isActive && website.activeModerationPreviousActive == null)
    ) {
      actions.push("REOPEN")
    }
  }
  return [...new Set(actions)]
}

export function getPublisherWebsiteLifecycleActions(
  website: WebsiteModerationSnapshot,
): ModerationActionValue[] {
  if (website.ownershipType !== "PUBLISHER") return []
  if (
    website.activeModerationAuthority === "OPERATIONS" ||
    website.activeModerationAuthority === "SUPER_ADMIN"
  ) {
    return []
  }
  if (website.isActive) return ["ARCHIVE"]
  if (
    website.activeModerationAction === "ARCHIVE" &&
    website.activeModerationAuthority === "PUBLISHER"
  ) {
    return ["REOPEN"]
  }
  return []
}

export function buildModerationProjection(
  target: ModerationFields & {
    activeModerationPreviousStatus?: ListingStatusValue | null
    activeModerationPreviousActive?: boolean | null
    moderationResubmissionAllowed?: boolean
  },
  allowedActions: readonly ModerationActionValue[],
) {
  const action = target.activeModerationAction ?? null
  return {
    version: target.moderationVersion ?? 0,
    allowedActions: [...allowedActions],
    active: action
      ? {
          action,
          authority: target.activeModerationAuthority ?? null,
          reasonCode: target.activeModerationReasonCode ?? null,
          publisherMessage: target.activeModerationMessage ?? null,
          previousStatus: target.activeModerationPreviousStatus ?? null,
          previousWebsiteActive: target.activeModerationPreviousActive ?? null,
          resubmissionAllowed: target.moderationResubmissionAllowed ?? false,
        }
      : null,
  }
}
