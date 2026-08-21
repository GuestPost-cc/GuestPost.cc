"use client"

import {
  type ModerationAction,
  moderationActionLabel,
  moderationReasonLabel,
  type PublisherModerationProjection,
} from "@guestpost/api-client"
import { Badge } from "@guestpost/ui"
import { AlertCircle, CheckCircle2, PauseCircle } from "lucide-react"

const GUIDANCE: Partial<Record<ModerationAction, string>> = {
  SUBMIT_FOR_REVIEW:
    "GuestPost is reviewing this inventory. You can keep preparing related details while the review is open.",
  APPROVE: "This inventory passed review.",
  REQUEST_CHANGES:
    "Update the requested details. Resubmit only when that action is available below.",
  PAUSE:
    "This inventory is unavailable to new buyers until the authority that placed the hold restores it.",
  RESTORE: "The prior hold has been resolved.",
  ARCHIVE:
    "This inventory is unavailable and cannot be resubmitted unless GuestPost reopens it.",
  REOPEN: "This inventory has been reopened for the next eligible action.",
  ALLOW_RESUBMISSION:
    "GuestPost has allowed a corrected submission when the readiness checks pass.",
  DENY_RESUBMISSION:
    "Resubmission is blocked. Contact support if you believe the underlying issue is resolved.",
}

function authorityLabel(authority: string) {
  if (authority === "PUBLISHER") return "You"
  if (authority === "SUPER_ADMIN") return "GuestPost Trust & Safety"
  return "GuestPost Operations"
}

export function PublisherModerationNotice({
  moderation,
  subject = "inventory",
}: {
  moderation?: PublisherModerationProjection | null
  subject?: "listing" | "domain" | "inventory"
}) {
  const event = moderation?.active
  if (!event) return null

  const restrictive = [
    "REQUEST_CHANGES",
    "PAUSE",
    "ARCHIVE",
    "DENY_RESUBMISSION",
  ].includes(event.action)
  const positive = [
    "APPROVE",
    "RESTORE",
    "REOPEN",
    "ALLOW_RESUBMISSION",
  ].includes(event.action)
  const Icon = restrictive
    ? event.action === "PAUSE"
      ? PauseCircle
      : AlertCircle
    : CheckCircle2
  const guidance =
    event.action === "ARCHIVE" &&
    event.authority === "PUBLISHER" &&
    moderation?.allowedActions.includes("SUBMIT_FOR_REVIEW")
      ? "You archived this listing. A new submission returns it to review; it never goes directly back to buyers."
      : event.action === "ARCHIVE" &&
          event.authority === "PUBLISHER" &&
          moderation?.allowedActions.includes("REOPEN")
        ? "You archived this domain. Reopen it before preparing the inventory for another review."
        : GUIDANCE[event.action]

  return (
    <div
      className={
        "rounded-xl border p-4 " +
        (restrictive
          ? "border-amber-300/60 bg-amber-50/70 dark:border-amber-900 dark:bg-amber-950/20"
          : positive
            ? "border-emerald-300/60 bg-emerald-50/70 dark:border-emerald-900 dark:bg-emerald-950/20"
            : "bg-muted/30")
      }
    >
      <div className="flex items-start gap-3">
        <Icon
          className={
            "mt-0.5 h-5 w-5 shrink-0 " +
            (restrictive
              ? "text-amber-700 dark:text-amber-300"
              : positive
                ? "text-emerald-700 dark:text-emerald-300"
                : "text-muted-foreground")
          }
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">
              {moderationActionLabel(event.action)} {subject}
            </p>
            <Badge variant="outline">
              {event.authority
                ? authorityLabel(event.authority)
                : "GuestPost Operations"}
            </Badge>
          </div>
          <p className="mt-1 text-sm">
            {event.reasonCode
              ? moderationReasonLabel(event.reasonCode)
              : "Reason unavailable"}
          </p>
          {event.publisherMessage ? (
            <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
              {event.publisherMessage}
            </p>
          ) : null}
          <p className="mt-2 text-xs leading-5 text-muted-foreground">
            {guidance}
          </p>
          {event.resubmissionAllowed === false ? (
            <p className="mt-1 text-xs font-medium text-amber-800 dark:text-amber-200">
              Resubmission requires a new staff decision.
            </p>
          ) : null}
        </div>
      </div>
    </div>
  )
}
