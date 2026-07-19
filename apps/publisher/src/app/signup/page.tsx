"use client"

import { sanitizeReturnTo } from "@guestpost/api-client"
import type { AuthError } from "@guestpost/auth"
import {
  getErrorMessage,
  getOAuthErrorMessage,
  signInWithProvider,
  signUp as signUpTransport,
} from "@guestpost/auth/client"
import { useSession } from "@guestpost/auth/react"
import { AuthCard, AuthLayout, GoogleIcon, SignupForm } from "@guestpost/ui"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useEffect, useMemo, useState } from "react"

const WEBSITE_URL =
  process.env.NEXT_PUBLIC_WEBSITE_URL ?? "http://localhost:3000"

function SignupContent() {
  const searchParams = useSearchParams()
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const { user, loading: sessionLoading } = useSession()
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
    if (user.userType === "PUBLISHER") {
      window.location.replace(returnTo)
      return
    }
    setError(
      user.userType === "CUSTOMER"
        ? "This Google account already belongs to a customer. Customer and publisher accounts must use different email addresses."
        : "Staff accounts cannot be used to create a publisher account.",
    )
  }, [returnTo, sessionLoading, user])

  const pageUrl = (path: string) => {
    const url = new URL(path, window.location.origin)
    if (returnTo !== "/dashboard") url.searchParams.set("returnTo", returnTo)
    return url.toString()
  }

  const handleGoogleSignup = async () => {
    setError(null)
    setSubmitting(true)
    try {
      await signInWithProvider("google", {
        callbackURL: pageUrl("/"),
        errorCallbackURL: pageUrl("/signup"),
        portal: "publisher",
        flow: "signup",
        termsAccepted: true,
      })
    } catch (err: unknown) {
      setError(getErrorMessage(err))
      setSubmitting(false)
    }
  }

  const handleSignup = async (data: {
    name: string
    email: string
    password: string
    termsAccepted: boolean
  }) => {
    setError(null)
    setSubmitting(true)
    try {
      const result = await signUpTransport({ ...data, portal: "publisher" })
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

  const loginHref =
    returnTo === "/dashboard"
      ? "/"
      : `/?returnTo=${encodeURIComponent(returnTo)}`

  return (
    <AuthLayout>
      <AuthCard
        eyebrow="New publisher"
        title="Create your publisher workspace"
        description="List websites and manage orders, integrations, earnings, and payouts."
        footer={
          <p>
            Already have an account?{" "}
            <Link
              href={loginHref}
              className="font-semibold text-primary hover:text-foreground"
            >
              Sign in
            </Link>
          </p>
        }
      >
        <SignupForm
          onSubmit={handleSignup}
          loading={submitting}
          error={error ?? undefined}
          submitLabel="Create publisher account"
          termsHref={`${WEBSITE_URL}/legal/terms`}
          oauthProvider={{
            id: "google",
            label: "Sign up with Google",
            icon: GoogleIcon,
            onClick: handleGoogleSignup,
          }}
        />
      </AuthCard>
    </AuthLayout>
  )
}

export default function PublisherSignupPage() {
  return (
    <Suspense
      fallback={
        <AuthLayout>
          <div className="animate-pulse text-zinc-500">Loading…</div>
        </AuthLayout>
      }
    >
      <SignupContent />
    </Suspense>
  )
}
