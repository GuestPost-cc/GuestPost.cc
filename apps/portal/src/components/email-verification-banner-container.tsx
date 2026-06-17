"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { EmailVerificationBanner } from "@guestpost/ui"
import { useAuth } from "../lib/auth"

// 60s client-side cooldown stacks on top of Phase 7.8 #26's per-IP +
// per-SHA-256(email) server-side rate limit. The server limiter is the
// authority; this is UX so users don't spam-click and get a 429.
const COOLDOWN_MS = 60_000

function getBaseUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_API_URL
  if (envUrl) return envUrl
  if (typeof window !== "undefined") {
    const host = window.location.hostname
    if (host !== "localhost" && host !== "127.0.0.1") return `http://${host}:4000`
  }
  return "http://localhost:4000"
}

// Phase 7.10 — Portal-app wiring around @guestpost/ui's
// <EmailVerificationBanner>. Hits Better Auth's built-in
// /api/v1/auth/send-verification-email endpoint via raw fetch (the
// portal's existing pattern in lib/auth.tsx for sign-in / sign-up /
// sign-out — see lines 94, 125, 144). No Better Auth client SDK
// introduced just for one button.
export function EmailVerificationBannerContainer() {
  const { user } = useAuth()
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [sending, setSending] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  // Tick once per second while in cooldown so the button label updates.
  // No interval runs when the banner is hidden or the cooldown is over.
  useEffect(() => {
    if (cooldownUntil <= now) return
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [cooldownUntil, now])

  // Banner only renders when actionable. PUBLISHER/STAFF aren't gated by
  // Phase 7.8 #25; verified customers don't need it; signed-out users
  // won't see it (this component lives inside the authenticated
  // dashboard layout).
  if (!user || user.emailVerified !== false || user.userType !== "CUSTOMER") return null

  const cooldownSeconds = Math.max(0, Math.ceil((cooldownUntil - now) / 1000))

  async function handleResend() {
    if (sending || cooldownSeconds > 0) return
    setSending(true)
    try {
      const res = await fetch(`${getBaseUrl()}/api/v1/auth/send-verification-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email: user!.email, callbackURL: "/dashboard" }),
      })
      if (!res.ok) {
        let message = "Couldn't send verification email"
        try {
          const body = await res.json()
          if (body?.message) message = body.message
        } catch {}
        throw new Error(message)
      }
      toast.success("Verification email sent. Check your inbox.")
      setCooldownUntil(Date.now() + COOLDOWN_MS)
    } catch (e: any) {
      toast.error(e?.message ?? "Couldn't send verification email")
    } finally {
      setSending(false)
    }
  }

  return (
    <EmailVerificationBanner
      email={user.email}
      sending={sending}
      cooldownSeconds={cooldownSeconds}
      onResend={handleResend}
    />
  )
}
