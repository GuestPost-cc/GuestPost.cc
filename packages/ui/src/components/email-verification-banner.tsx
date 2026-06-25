"use client"

import type * as React from "react"
import { Button } from "./button"

export interface EmailVerificationBannerProps {
  /** The email address shown in the default copy. */
  email: string
  /** Disabled because a resend is in flight. */
  sending?: boolean
  /** Seconds remaining on a client-side cooldown; 0 (or undefined) means active. */
  cooldownSeconds?: number
  /** Called when the user clicks "Resend email" from the active state. */
  onResend: () => void
  /**
   * Optional copy override. Useful if a future publisher/admin app
   * mounts this for a different verification flag (KYC, 2FA, etc.).
   */
  message?: React.ReactNode
}

// Phase 7.10 — Presentational shell for the "your email isn't verified"
// banner. Lives in @guestpost/ui so future publisher/admin verification
// gates can mount the same UI without copy-paste. App-specific data
// wiring (auth context, resend POST, toast) lives in a thin container
// in each app — see apps/portal/src/components/email-verification-banner-container.tsx
// for the reference implementation.
export function EmailVerificationBanner({
  email,
  sending,
  cooldownSeconds,
  onResend,
  message,
}: EmailVerificationBannerProps) {
  const inCooldown = (cooldownSeconds ?? 0) > 0
  const disabled = !!sending || inCooldown

  let label: string
  if (sending) label = "Sending…"
  else if (inCooldown) label = `Resend in ${cooldownSeconds}s`
  else label = "Resend email"

  return (
    <div
      role="status"
      className="border-b bg-amber-50 px-4 py-3 text-sm text-amber-900 flex items-center justify-between gap-4 flex-wrap"
    >
      <div>
        {message ?? (
          <>
            <strong>Please verify your email.</strong> We sent a link to{" "}
            <code className="font-mono">{email}</code>. Some actions are
            restricted until you confirm.
          </>
        )}
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onResend}
        disabled={disabled}
      >
        {label}
      </Button>
    </div>
  )
}
