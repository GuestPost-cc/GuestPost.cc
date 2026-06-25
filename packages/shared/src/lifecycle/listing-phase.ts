// Derived lifecycle phase for a MarketplaceListing. The phase is what the UI
// SHOWS the user; the DB `status` enum stays compact (DRAFT / PENDING_REVIEW
// / APPROVED / REJECTED / PAUSED / ARCHIVED) because the phase is a function
// of (status, ownerType, website verification, AVAILABLE service count).
//
// Keeping this in @guestpost/shared means the API, the customer portal, the
// publisher app, and the admin app all agree on what "AWAITING_VERIFICATION"
// means. Never re-implement.

export type ListingStatus =
  | "DRAFT"
  | "PENDING_REVIEW"
  | "APPROVED"
  | "REJECTED"
  | "PAUSED"
  | "ARCHIVED"

export type ListingOwnerType = "PUBLISHER" | "PLATFORM"

export type WebsiteVerificationStatus =
  | "PENDING_VERIFICATION"
  | "VERIFIED"
  | "VERIFICATION_FAILED"
  | "REVOKED"
  | null
  | undefined

export type ListingLifecyclePhase =
  // Publisher path
  | "AWAITING_VERIFICATION" // DRAFT, website still unverified
  | "AWAITING_SERVICES" // DRAFT, no AVAILABLE service yet
  | "READY_FOR_REVIEW" // DRAFT + verified + ≥1 AVAILABLE → publisher can submit
  | "IN_REVIEW" // PENDING_REVIEW
  // Platform path: no admin review step
  | "READY_TO_PUBLISH" // DRAFT + ≥1 AVAILABLE → admin can publish
  // Shared terminal/active states
  | "PUBLISHED" // APPROVED
  | "PAUSED"
  | "REJECTED"
  | "ARCHIVED"

export interface ListingPhaseInput {
  status: ListingStatus
  ownerType: ListingOwnerType
  // VERIFIED for platform sites (auto on create); for publisher sites,
  // pending until DNS TXT sweep confirms ownership.
  websiteVerificationStatus?: WebsiteVerificationStatus
  // Count of ListingService rows with availability=AVAILABLE.
  availableServiceCount: number
}

// Pure function. Order of conditions matters — terminal states first so a
// PAUSED/REJECTED/ARCHIVED listing never reports "AWAITING_*" even if its
// underlying website was later revoked.
export function computeListingPhase(
  input: ListingPhaseInput,
): ListingLifecyclePhase {
  const {
    status,
    ownerType,
    websiteVerificationStatus,
    availableServiceCount,
  } = input

  if (status === "ARCHIVED") return "ARCHIVED"
  if (status === "REJECTED") return "REJECTED"
  if (status === "PAUSED") return "PAUSED"
  if (status === "APPROVED") return "PUBLISHED"
  if (status === "PENDING_REVIEW") return "IN_REVIEW"

  // status === "DRAFT" from here on.
  if (ownerType === "PLATFORM") {
    return availableServiceCount > 0 ? "READY_TO_PUBLISH" : "AWAITING_SERVICES"
  }

  // PUBLISHER path
  if (websiteVerificationStatus !== "VERIFIED") return "AWAITING_VERIFICATION"
  if (availableServiceCount === 0) return "AWAITING_SERVICES"
  return "READY_FOR_REVIEW"
}

// Phases that MEAN the listing is currently buyable from the marketplace.
// Settlement / search / customer flows treat PUBLISHED as the only “live”
// state; the rest are internal.
export function isListingLive(phase: ListingLifecyclePhase): boolean {
  return phase === "PUBLISHED"
}

// Phases from which a publisher can submit for review. Used as the gate
// for POST /marketplace/listings/:id/submit and as the UI "Submit" enable
// condition. Strict subset of DRAFT-side phases.
export function canSubmitForReview(phase: ListingLifecyclePhase): boolean {
  return phase === "READY_FOR_REVIEW"
}

// Phases from which a publisher can pause / unpause / archive. The current
// status drives the actual transition; the phase is used for UI affordance.
export function canPause(phase: ListingLifecyclePhase): boolean {
  return phase === "PUBLISHED"
}
export function canUnpause(phase: ListingLifecyclePhase): boolean {
  return phase === "PAUSED"
}
export function canArchive(phase: ListingLifecyclePhase): boolean {
  return phase !== "ARCHIVED"
}
