"use client"

import { sanitizeReturnTo } from "@guestpost/api-client"
import { getErrorMessage } from "@guestpost/auth/client"
import {
  AuthCard,
  AuthLayout,
  LoginForm,
  useSessionExpired,
} from "@guestpost/ui"
import { useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"
import { useAuth } from "../lib/auth"

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
  const { expired, reason } = useSessionExpired()
  const { user, loading: sessionLoading, sessionError, signIn } = useAuth()

  const safeReturnTo = (() => {
    const raw = searchParams.get("returnTo")
    return sanitizeReturnTo(raw) ?? "/dashboard"
  })()

  useEffect(() => {
    if (!sessionLoading && user?.userType === "STAFF") {
      window.location.replace(safeReturnTo)
    }
  }, [safeReturnTo, sessionLoading, user])

  const handleSignIn = async (data: { email: string; password: string }) => {
    setError(null)
    setLoading(true)
    try {
      await signIn(data.email, data.password)
      window.location.replace(safeReturnTo)
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  if (sessionLoading || user) {
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
          error={error ?? sessionError ?? undefined}
          forgotPasswordHref="/forgot-password"
          submitLabel="Open admin dashboard"
        />
      </AuthCard>
    </AuthLayout>
  )
}
