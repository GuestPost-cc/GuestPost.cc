import { ForbiddenException } from "@nestjs/common"

// Phase 6.9 — Audit finding #3 + R-3 + R-4 closure.
//
// Money-touching customer endpoints (submit-payment, approve-content,
// confirm-delivery, customer-accept-delivery, customer-approve-settlement,
// submit-review) all share the same authorization invariant:
//
//   "The order's creator OR the org's OWNER may act."
//
// MEMBER access at the controller layer is fine because the broad gate
// admits the legitimate cases (a MEMBER acting on THEIR OWN order, or
// an OWNER acting on any org order). What's refused is a non-creator
// MEMBER acting on a sibling MEMBER's order — which was the audit's
// CRITICAL finding (any invited intern could drain the wallet).
//
// The check lives in the service layer so it has access to the Order row
// (which the guard layer doesn't load uniformly). Three of the six call
// sites already had this check inline; this helper consolidates the
// pattern so future endpoints get it right by default and we never drift.
//
// Pure function, takes only what it needs — no PrismaService dep — so it's
// trivially testable and can be called from any service.

export interface OwnerOrCreatorContext {
  /** The order's customerId (= the user who originally placed the order). */
  customerId: string
  /** The acting user's id. */
  actorUserId: string
  /** The acting user's customerRole in the relevant org ("OWNER" or "MEMBER"). */
  actorRole: string | null | undefined
  /** Optional override of the message; useful for action-specific copy. */
  action?: string
}

/**
 * Throws `ForbiddenException` when the actor is neither the order's creator
 * nor an OWNER of the order's organization.
 *
 * Callers MUST have already verified org-ownership of the order (typically
 * by including `organizationId` in the order fetch query, or via
 * `OrderOwnershipGuard`). This helper does NOT re-verify tenancy — its job
 * is the OWNER||creator narrowing on top of an already-verified org match.
 */
export function assertOwnerOrCreator(ctx: OwnerOrCreatorContext): void {
  const isCreator = ctx.customerId === ctx.actorUserId
  const isOwner = ctx.actorRole === "OWNER"
  if (!isCreator && !isOwner) {
    throw new ForbiddenException(
      ctx.action
        ? `Only the order's creator or organization OWNER can ${ctx.action}`
        : "Only the order's creator or organization OWNER can perform this action",
    )
  }
}
