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
import {
  AuthAudienceTabs,
  AuthCard,
  AuthLayout,
  GoogleIcon,
  type PublicAuthAudience,
  SignupForm,
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

function SignupContent() {
  const searchParams = useSearchParams()
  const initialAudience =
    searchParams.get("audience") === "publisher" ? "publisher" : "customer"
  const [audience, setAudience] = useState<PublicAuthAudience>(initialAudience)
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
    if (user.userType === "CUSTOMER") {
      window.location.replace(destination("customer", returnTo))
    } else if (user.userType === "PUBLISHER") {
      window.location.replace(destination("publisher", returnTo))
    } else {
      setError("Staff accounts cannot be used to create a public account.")
    }
  }, [returnTo, sessionLoading, user])

  const pageUrl = (path: "/login" | "/signup") => {
    const url = new URL(path, window.location.origin)
    url.searchParams.set("audience", audience)
    if (returnTo !== "/dashboard") url.searchParams.set("returnTo", returnTo)
    return url.toString()
  }

  const handleGoogleSignup = async () => {
    setError(null)
    setSubmitting(true)
    try {
      await signInWithProvider("google", {
        callbackURL: pageUrl("/login"),
        errorCallbackURL: pageUrl("/signup"),
        portal: audience,
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
      const result = await signUpTransport({ ...data, portal: audience })
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

  const loginHref = `/login?audience=${audience}${
    returnTo === "/dashboard" ? "" : `&returnTo=${encodeURIComponent(returnTo)}`
  }`

  return (
    <AuthLayout>
      <AuthCard
        eyebrow="Create your account"
        title={
          audience === "customer"
            ? "Create a customer workspace"
            : "Create a publisher workspace"
        }
        description={
          audience === "customer"
            ? "Discover publishers and manage campaigns from one secure workspace."
            : "List websites and manage orders, earnings, and payouts."
        }
        footer={
          <p>
            Already have an account?{" "}
            <Link
              href={loginHref}
              className="font-semibold text-sky-300 hover:text-sky-200"
            >
              Sign in
            </Link>
          </p>
        }
        className="max-w-[440px]"
      >
        <AuthAudienceTabs value={audience} onChange={changeAudience} />
        <SignupForm
          onSubmit={handleSignup}
          loading={submitting}
          error={error ?? undefined}
          submitLabel={
            audience === "customer"
              ? "Create customer account"
              : "Create publisher account"
          }
          termsHref="/legal/terms"
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

export default function WebsiteSignupPage() {
  return (
    <Suspense
      fallback={
        <AuthLayout>
          <div className="animate-pulse text-zinc-400">Loading…</div>
        </AuthLayout>
      }
    >
      <SignupContent />
    </Suspense>
  )
}
