"use client"

import type { AuthError } from "@guestpost/auth"
import {
  getErrorMessage,
  getSession as serverGetSession,
  signIn as signInTransport,
} from "@guestpost/auth/client"
import {
  AuthCard,
  AuthLayout,
  LoginForm,
  useSessionExpired,
} from "@guestpost/ui"
import { useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  )
}

function LoginPageInner() {
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [initialCheck, setInitialCheck] = useState(true)
  const { expired, reason, dismiss } = useSessionExpired()

  const safeReturnTo = (() => {
    const raw = searchParams.get("returnTo")
    if (raw && raw !== "/" && raw.startsWith("/")) return raw
    return "/dashboard"
  })()

  useEffect(() => {
    // Check if already signed in as staff
    async function checkSession() {
      try {
        const sessionResult = await serverGetSession()
        if (sessionResult?.user?.userType === "STAFF") {
          // Hard navigation — router.push() leaves the Next.js layout with
          // stale session state and can bounce back to the login page.
          window.location.href = safeReturnTo
          return
        }
      } catch {
        // ignore
      }
      setInitialCheck(false)
    }
    checkSession()
  }, [safeReturnTo])

  const handleSignIn = async (data: { email: string; password: string }) => {
    setError(null)
    setLoading(true)
    try {
      const result = await signInTransport(data)
      if (result.status === "mfa_required") {
        throw {
          code: "MFA_REQUIRED",
          message: "Multi-factor authentication is required.",
          recoverable: true,
        } as AuthError
      }
      const session = await serverGetSession()
      if (session.user?.userType !== "STAFF") {
        throw {
          code: "WRONG_AUDIENCE",
          message:
            "This portal is for staff only. Please sign in at the correct portal.",
          recoverable: true,
        } as AuthError
      }
      window.location.href = safeReturnTo
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  if (initialCheck) {
    return (
      <AuthLayout>
        <div className="animate-pulse text-zinc-500">Loading...</div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <AuthCard
        eyebrow="Admin login"
        title="Welcome back"
        description="Sign in to manage platform operations, users, and moderation."
      >
        {expired && (
          <div
            role="status"
            aria-live="polite"
            className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-sm leading-6 text-amber-300"
          >
            {reason}
          </div>
        )}
        <LoginForm
          onSubmit={handleSignIn}
          loading={loading}
          error={error ?? undefined}
          forgotPasswordHref="/forgot-password"
          submitLabel="Open admin dashboard"
        />
      </AuthCard>
    </AuthLayout>
  )
}
