"use client"

import type { AuthError } from "@guestpost/auth"
import {
  getErrorMessage,
  isAuthError,
  getSession as serverGetSession,
  signIn as signInTransport,
} from "@guestpost/auth/client"
import {
  AuthCard,
  AuthLayout,
  LoginForm,
  useSessionExpired,
} from "@guestpost/ui"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginPageInner />
    </Suspense>
  )
}

function LoginPageInner() {
  const router = useRouter()
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
          router.push(safeReturnTo)
          return
        }
      } catch {
        // ignore
      }
      setInitialCheck(false)
    }
    checkSession()
  }, [router, safeReturnTo])

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
      router.push(safeReturnTo)
    } catch (err: any) {
      setError(
        isAuthError(err)
          ? getErrorMessage(err)
          : (err.message ?? "Something went wrong"),
      )
    } finally {
      setLoading(false)
    }
  }

  if (initialCheck) {
    return (
      <AuthLayout>
        <div className="animate-pulse text-muted-foreground">Loading...</div>
      </AuthLayout>
    )
  }

  return (
    <AuthLayout>
      <AuthCard
        title="Admin Sign In"
        description="Sign in to manage the platform"
      >
        {expired && (
          <div
            role="status"
            aria-live="polite"
            className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {reason}
          </div>
        )}
        <LoginForm
          onSubmit={handleSignIn}
          loading={loading}
          error={error ?? undefined}
        />
      </AuthCard>
    </AuthLayout>
  )
}
