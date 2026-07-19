"use client"

import { sanitizeReturnTo } from "@guestpost/api-client"
import type { AuthError } from "@guestpost/auth"
import {
  getErrorMessage,
  getOAuthErrorMessage,
  signIn as signInTransport,
  signInWithProvider,
} from "@guestpost/auth/client"
import { useSession } from "@guestpost/auth/react"
import {
  AuthCard,
  AuthLayout,
  AuthProviders,
  GoogleIcon,
  LoginForm,
  useSessionExpired,
} from "@guestpost/ui"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useEffect, useMemo, useState } from "react"

const PUBLISHER_URL =
  process.env.NEXT_PUBLIC_PUBLISHER_URL ?? "http://localhost:3002"

function LoginContent() {
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const resetSucceeded = searchParams.get("reset") === "success"
  const { expired, reason } = useSessionExpired()
  const { user, loading: sessionLoading } = useSession()

  const returnTo = useMemo(
    () =>
      sanitizeReturnTo(
        searchParams.get("returnTo") ?? searchParams.get("redirect"),
      ) ?? "/dashboard",
    [searchParams],
  )

  useEffect(() => {
    const oauthError = getOAuthErrorMessage(searchParams.get("error"))
    if (oauthError) setError(oauthError)
  }, [searchParams])

  useEffect(() => {
    if (sessionLoading || !user) return
    if (user.userType === "CUSTOMER") {
      window.location.replace(returnTo)
      return
    }
    if (user.userType === "PUBLISHER") {
      setError(
        "This account is registered as a publisher. Open the Publisher portal or use another account.",
      )
      return
    }
    setError("Staff accounts must sign in through the Admin portal.")
  }, [returnTo, sessionLoading, user])

  const authPageUrl = () => {
    const url = new URL("/", window.location.origin)
    if (returnTo !== "/dashboard") url.searchParams.set("returnTo", returnTo)
    return url.toString()
  }

  const handleGoogleSignIn = async () => {
    setError(null)
    setSubmitting(true)
    try {
      const callbackURL = authPageUrl()
      await signInWithProvider("google", {
        callbackURL,
        errorCallbackURL: callbackURL,
        portal: "customer",
        flow: "login",
      })
    } catch (err: unknown) {
      setError(getErrorMessage(err))
      setSubmitting(false)
    }
  }

  const handleSignIn = async (data: { email: string; password: string }) => {
    setError(null)
    setSubmitting(true)
    try {
      const result = await signInTransport({ ...data, portal: "customer" })
      if (result.status === "mfa_required") {
        throw {
          code: "MFA_REQUIRED",
          message: "Multi-factor authentication is required.",
          recoverable: true,
        } as AuthError
      }
      window.location.replace(returnTo)
    } catch (err: unknown) {
      setError(getErrorMessage(err))
      setSubmitting(false)
    }
  }

  const signupHref =
    returnTo === "/dashboard"
      ? "/signup"
      : `/signup?returnTo=${encodeURIComponent(returnTo)}`

  return (
    <AuthLayout>
      <AuthCard
        eyebrow="Customer portal"
        title="Welcome back"
        description="Sign in to manage campaigns, orders, billing, and marketplace discovery."
        footer={
          <p>
            New to GuestPost?{" "}
            <Link
              href={signupHref}
              className="font-semibold text-primary hover:text-foreground"
            >
              Create a customer account
            </Link>
          </p>
        }
      >
        {expired && (
          <div
            role="status"
            className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300"
          >
            {reason}
          </div>
        )}
        {resetSucceeded && (
          <div
            role="status"
            className="mb-4 rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300"
          >
            Your password was updated. Sign in with your new password.
          </div>
        )}
        {user?.userType === "PUBLISHER" && (
          <a
            href={`${PUBLISHER_URL}/dashboard`}
            className="mb-4 block rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2.5 text-center text-sm font-semibold text-zinc-100 hover:bg-zinc-800"
          >
            Open Publisher dashboard
          </a>
        )}
        <AuthProviders
          separator="or sign in with email"
          providers={[
            {
              id: "google",
              label: "Sign in with Google",
              icon: GoogleIcon,
              onClick: handleGoogleSignIn,
            },
          ]}
        />
        <LoginForm
          onSubmit={handleSignIn}
          loading={submitting}
          error={error ?? undefined}
          forgotPasswordHref="/forgot-password"
          submitLabel="Open customer dashboard"
        />
      </AuthCard>
    </AuthLayout>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <AuthLayout>
          <div className="animate-pulse text-zinc-500">Loading…</div>
        </AuthLayout>
      }
    >
      <LoginContent />
    </Suspense>
  )
}
