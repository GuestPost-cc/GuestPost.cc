"use client"

import {
  MODERATION_REASON_LABELS,
  type ModerationAction,
  type ModerationCommand,
  type ModerationReasonCode,
  type ModerationScope,
  moderationActionLabel,
} from "@guestpost/api-client"
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@guestpost/ui"
import { useEffect, useState } from "react"

type CurrentReasonCode = Exclude<ModerationReasonCode, "LEGACY_ORIGIN_UNKNOWN">

const REASON_CODES_BY_ACTION: Record<
  ModerationAction,
  readonly CurrentReasonCode[]
> = {
  SUBMIT_FOR_REVIEW: ["INITIAL_SUBMISSION", "CORRECTIONS_COMPLETE"],
  APPROVE: [
    "APPROVED_AFTER_REVIEW",
    "CORRECTIONS_COMPLETE",
    "ISSUE_RESOLVED",
    "EMERGENCY_OVERRIDE",
  ],
  REQUEST_CHANGES: [
    "INCOMPLETE_POLICY",
    "INCOMPLETE_LISTING",
    "CONTENT_QUALITY",
    "PRICING_OR_SERVICE",
    "DOMAIN_VERIFICATION",
    "POLICY_VIOLATION",
    "OTHER",
  ],
  PAUSE: [
    "SECURITY_RISK",
    "FRAUD_RISK",
    "INVENTORY_UNAVAILABLE",
    "OPERATIONAL_HOLD",
    "PUBLISHER_REQUEST",
    "POLICY_VIOLATION",
    "OTHER",
  ],
  RESTORE: [
    "ISSUE_RESOLVED",
    "CORRECTIONS_COMPLETE",
    "PUBLISHER_REQUEST",
    "EMERGENCY_OVERRIDE",
  ],
  ARCHIVE: [
    "DUPLICATE_OR_INVALID",
    "POLICY_VIOLATION",
    "FRAUD_RISK",
    "SECURITY_RISK",
    "INVENTORY_UNAVAILABLE",
    "PUBLISHER_REQUEST",
    "OTHER",
  ],
  REOPEN: [
    "ISSUE_RESOLVED",
    "CORRECTIONS_COMPLETE",
    "EMERGENCY_OVERRIDE",
    "OTHER",
  ],
  ALLOW_RESUBMISSION: [
    "CORRECTIONS_COMPLETE",
    "ISSUE_RESOLVED",
    "EMERGENCY_OVERRIDE",
  ],
  DENY_RESUBMISSION: [
    "POLICY_VIOLATION",
    "FRAUD_RISK",
    "SECURITY_RISK",
    "OTHER",
  ],
}

const DEFAULT_REASON: Record<ModerationAction, ModerationReasonCode> = {
  SUBMIT_FOR_REVIEW: "INITIAL_SUBMISSION",
  APPROVE: "APPROVED_AFTER_REVIEW",
  REQUEST_CHANGES: "INCOMPLETE_LISTING",
  PAUSE: "OPERATIONAL_HOLD",
  RESTORE: "ISSUE_RESOLVED",
  ARCHIVE: "DUPLICATE_OR_INVALID",
  REOPEN: "ISSUE_RESOLVED",
  ALLOW_RESUBMISSION: "CORRECTIONS_COMPLETE",
  DENY_RESUBMISSION: "POLICY_VIOLATION",
}

const HIGH_IMPACT_ACTIONS: ReadonlySet<ModerationAction> = new Set([
  "REQUEST_CHANGES",
  "PAUSE",
  "ARCHIVE",
  "DENY_RESUBMISSION",
])

const MESSAGE_REQUIRED_ACTIONS = HIGH_IMPACT_ACTIONS

export function moderationActionIsDestructive(action: ModerationAction) {
  return HIGH_IMPACT_ACTIONS.has(action)
}

export function ModerationActionDialog({
  action,
  scope,
  targetLabel,
  ownerType,
  version,
  open,
  pending,
  onOpenChange,
  onConfirm,
}: {
  action: ModerationAction | null
  scope: ModerationScope
  targetLabel: string
  ownerType: "PUBLISHER" | "PLATFORM"
  version: number
  open: boolean
  pending: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: (command: ModerationCommand) => void
}) {
  const [reasonCode, setReasonCode] = useState<ModerationReasonCode>("OTHER")
  const [message, setMessage] = useState("")

  useEffect(() => {
    if (!open || !action) return
    setReasonCode(DEFAULT_REASON[action])
    setMessage("")
  }, [action, open])

  if (!action) return null

  const needsNarrative = MESSAGE_REQUIRED_ACTIONS.has(action)
  const publisherFacing = ownerType === "PUBLISHER"
  const messageValid = !needsNarrative || message.trim().length >= 10
  const actionLabel = moderationActionLabel(action)

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{actionLabel}</DialogTitle>
          <DialogDescription>
            {targetLabel} · {scope === "LISTING" ? "listing" : "domain"}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="rounded-lg border border-amber-500/25 bg-amber-500/5 p-3 text-sm text-muted-foreground">
            This creates an immutable moderation event. The current version is
            checked before the action is applied so a newer staff decision is
            never overwritten silently.
          </div>

          <div className="space-y-2">
            <Label htmlFor="moderation-reason">Structured reason</Label>
            <Select
              value={reasonCode}
              onValueChange={(value) =>
                setReasonCode(value as ModerationReasonCode)
              }
            >
              <SelectTrigger id="moderation-reason">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASON_CODES_BY_ACTION[action].map((code) => (
                  <SelectItem key={code} value={code}>
                    {MODERATION_REASON_LABELS[code]}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {(needsNarrative || message) && (
            <div className="space-y-2">
              <Label htmlFor="moderation-message">
                {publisherFacing
                  ? "Message shown to the publisher"
                  : "Internal operations note"}
              </Label>
              <Textarea
                id="moderation-message"
                rows={4}
                value={message}
                onChange={(event) => setMessage(event.target.value)}
                placeholder={
                  publisherFacing
                    ? "Explain what changed and the publisher's next step."
                    : "Record why this platform inventory action is needed."
                }
              />
              {needsNarrative ? (
                <p className="text-xs text-muted-foreground">
                  Enter at least 10 characters.
                  {publisherFacing
                    ? " Do not include internal-only investigation details."
                    : " This note is visible only to staff."}
                </p>
              ) : null}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            variant={
              moderationActionIsDestructive(action) ? "destructive" : "default"
            }
            disabled={!messageValid || pending}
            onClick={() =>
              onConfirm({
                action,
                expectedVersion: version,
                reasonCode,
                ...(publisherFacing
                  ? { publisherMessage: message.trim() || undefined }
                  : { internalNote: message.trim() || undefined }),
              })
            }
          >
            {pending ? "Applying…" : `Confirm ${actionLabel.toLowerCase()}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
