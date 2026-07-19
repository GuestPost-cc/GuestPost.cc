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
  AuthAudienceTabs,
  AuthCard,
  AuthLayout,
  AuthProviders,
  GoogleIcon,
  LoginForm,
  type PublicAuthAudience,
  useSessionExpired,
} from "@guestpost/ui"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useEffect, useMemo, useState } from "react"

const DESTINATIONS = {
  customer: process.env.NEXT_PUBLIC_PORTAL_URL ?? "http://localhost:3001",
  publisher: process.env.NEXT_PUBLIC_PUBLISHER_URL ?? "http://localhost:3002",
} as const

function destination(audience: PublicAuthAudience, path: string): string {
  return new URL(path, DESTINATIONS[audience]).toString()
}

function LoginContent() {
  const searchParams = useSearchParams()
  const initialAudience =
    searchParams.get("audience") === "publisher" ? "publisher" : "customer"
  const [audience, setAudience] = useState<PublicAuthAudience>(initialAudience)
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const resetSucceeded = searchParams.get("reset") === "success"
  const { user, loading: sessionLoading } = useSession()
  const { expired, reason } = useSessionExpired()
  const returnTo = useMemo(
    () => sanitizeReturnTo(searchParams.get("returnTo")) ?? "/dashboard",
    [searchParams],
  )

  useEffect(() => {
    const oauthError = getOAuthErrorMessage(searchParams.get("error"))
    if (oauthError) setError(oauthError)
  }, [searchParams])

  useEffect(() => {
    if (sessionLoading || !user) return
    if (user.banned) {
      setError(
        "This account is suspended. Contact support if you believe this is a mistake.",
      )
      return
    }
    if (user.userType === "CUSTOMER") {
      window.location.replace(destination("customer", returnTo))
    } else if (user.userType === "PUBLISHER") {
      window.location.replace(destination("publisher", returnTo))
    } else {
      setError("Staff accounts must sign in through the Admin portal.")
    }
  }, [returnTo, sessionLoading, user])

  const pageUrl = () => {
    const url = new URL("/login", window.location.origin)
    url.searchParams.set("audience", audience)
    if (returnTo !== "/dashboard") url.searchParams.set("returnTo", returnTo)
    return url.toString()
  }

  const handleGoogleSignIn = async () => {
    setError(null)
    setSubmitting(true)
    try {
      const callbackURL = pageUrl()
      await signInWithProvider("google", {
        callbackURL,
        errorCallbackURL: callbackURL,
        portal: audience,
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
      const result = await signInTransport({ ...data, portal: audience })
      if (result.status === "mfa_required") {
        throw {
          code: "MFA_REQUIRED",
          message: "Multi-factor authentication is required.",
          recoverable: true,
        } as AuthError
      }
      window.location.replace(destination(audience, returnTo))
    } catch (err: unknown) {
      setError(getErrorMessage(err))
      setSubmitting(false)
    }
  }

  const changeAudience = (next: PublicAuthAudience) => {
    setAudience(next)
    setError(null)
  }

  const signupHref = `/signup?audience=${audience}${
    returnTo === "/dashboard" ? "" : `&returnTo=${encodeURIComponent(returnTo)}`
  }`

  return (
    <AuthLayout>
      <AuthCard
        eyebrow="Secure account access"
        title={audience === "customer" ? "Welcome back" : "Publisher login"}
        description={
          audience === "customer"
            ? "Sign in to manage your orders and campaigns."
            : "Sign in to manage listings, orders, earnings, and payouts."
        }
        footer={
          <p>
            New to GuestPost?{" "}
            <Link
              href={signupHref}
              className="font-semibold text-sky-300 hover:text-sky-200"
            >
              Create an account
            </Link>
          </p>
        }
        className="max-w-[440px]"
      >
        <AuthAudienceTabs value={audience} onChange={changeAudience} />
        {expired && (
          <div
            role="status"
            className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-sm text-amber-300"
          >
            {reason}
          </div>
        )}
        {resetSucceeded && (
          <div
            role="status"
            className="rounded-lg border border-emerald-500/20 bg-emerald-500/10 px-3 py-2.5 text-sm text-emerald-300"
          >
            Your password was updated. Sign in with your new password.
          </div>
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
          forgotPasswordHref={`/forgot-password?audience=${audience}`}
          submitLabel={
            audience === "customer"
              ? "Open customer dashboard"
              : "Open publisher dashboard"
          }
        />
      </AuthCard>
    </AuthLayout>
  )
}

export default function WebsiteLoginPage() {
  return (
    <Suspense
      fallback={
        <AuthLayout>
          <div className="animate-pulse text-zinc-400">Loading…</div>
        </AuthLayout>
      }
    >
      <LoginContent />
    </Suspense>
  )
}
