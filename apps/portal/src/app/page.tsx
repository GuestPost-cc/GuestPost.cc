"use client"

import { setToken } from "@guestpost/api-client"
import type { AuthError } from "@guestpost/auth"
import {
  getErrorMessage,
  getSession,
  isAuthError,
  signIn as signInTransport,
  signInWithProvider,
  signUp as signUpTransport,
} from "@guestpost/auth/client"
import { useSession } from "@guestpost/auth/react"
import {
  AuthCard,
  AuthLayout,
  AuthProviders,
  LoginForm,
  SignupForm,
  useSessionExpired,
} from "@guestpost/ui"
import { useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"

function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
        fill="#4285F4"
      />
      <path
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
        fill="#34A853"
      />
      <path
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
        fill="#FBBC05"
      />
      <path
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
        fill="#EA4335"
      />
    </svg>
  )
}

const customerLayoutFeatures = [
  {
    title: "Discover publishers",
    description:
      "Browse marketplace opportunities and shortlist placements faster.",
  },
  {
    title: "Manage campaigns",
    description:
      "Keep briefs, orders, billing, and status updates in one workspace.",
  },
  {
    title: "Track delivery",
    description: "Follow each guest post from checkout through publication.",
  },
  {
    title: "Work securely",
    description:
      "Sign in with email or Google while the platform handles access checks.",
  },
]

const customerLayoutStats = [
  { value: "Discover", label: "find relevant publisher inventory" },
  { value: "Order", label: "launch guest post placements" },
  { value: "Track", label: "monitor campaign progress" },
]

function LoginContent() {
  const searchParams = useSearchParams()
  const [isSignUp, setIsSignUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const { expired, reason } = useSessionExpired()
  const { user } = useSession()

  useEffect(() => {
    if (searchParams.get("signup") === "true") {
      setIsSignUp(true)
    }
  }, [searchParams])

  // Redirect already-authenticated CUSTOMER users away from the login page.
  // Must also hydrate the Bearer token (setToken) for the HttpClient-based
  // dashboard — otherwise POST requests (create org, etc.) are blocked by
  // the CSRF middleware.
  useEffect(() => {
    if (user?.userType === "CUSTOMER") {
      window.location.href = "/dashboard"
    }
  }, [user])

  const handleGoogleSignIn = async () => {
    setError(null)
    try {
      await signInWithProvider("google", window.location.origin, "customer")
    } catch (err: any) {
      setError(
        isAuthError(err)
          ? getErrorMessage(err)
          : (err.message ?? "Something went wrong"),
      )
    }
  }

  const handleSignIn = async (data: { email: string; password: string }) => {
    setError(null)
    setLoading(true)
    try {
      const result = await signInTransport({ ...data, portal: "customer" })
      if (result.status === "authenticated" && result.token) {
        setToken(result.token)
      }
      if (result.status === "mfa_required") {
        throw {
          code: "MFA_REQUIRED",
          message:
            "Multi-factor authentication is required. Please complete verification.",
          recoverable: true,
        } as AuthError
      }
      const session = await getSession()
      if (session.user?.userType !== "CUSTOMER") {
        throw {
          code: "WRONG_AUDIENCE",
          message:
            "This portal is for customers only. Please sign in at the correct portal.",
          recoverable: true,
        } as AuthError
      }
      const returnTo = searchParams.get("returnTo")
      const safeReturnTo =
        returnTo && returnTo !== "/" ? returnTo : "/dashboard"
      window.location.href = safeReturnTo
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

  const handleSignUp = async (data: {
    name: string
    email: string
    password: string
  }) => {
    setError(null)
    setLoading(true)
    try {
      const result = await signUpTransport({ ...data, portal: "customer" })
      if (result.status === "authenticated" && result.token) {
        setToken(result.token)
      }
      if (result.status === "mfa_required") {
        throw {
          code: "MFA_REQUIRED",
          message:
            "Multi-factor authentication is required. Please complete verification.",
          recoverable: true,
        } as AuthError
      }
      const session = await getSession()
      if (session.user?.userType !== "CUSTOMER") {
        throw {
          code: "WRONG_AUDIENCE",
          message:
            "This portal is for customers only. Please use the publisher portal to sign up.",
          recoverable: true,
        } as AuthError
      }
      const returnTo = searchParams.get("returnTo")
      const safeReturnTo =
        returnTo && returnTo !== "/" ? returnTo : "/dashboard"
      window.location.href = safeReturnTo
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

  return (
    <AuthLayout
      eyebrow="Customer portal"
      title="Launch better guest post campaigns with confidence."
      description="Plan, order, and track guest post placements from a focused workspace built for buyers."
      features={customerLayoutFeatures}
      stats={customerLayoutStats}
    >
      <AuthCard
        eyebrow={isSignUp ? "New customer" : "Customer login"}
        title={isSignUp ? "Create your customer workspace" : "Welcome back"}
        description={
          isSignUp
            ? "Start a buyer account to discover publishers and manage campaigns."
            : "Sign in to manage campaigns, orders, billing, and marketplace discovery."
        }
        footer={
          <p className="text-center text-sm text-muted-foreground">
            {isSignUp ? (
              <>
                Already have an account?{" "}
                <button
                  type="button"
                  onClick={() => setIsSignUp(false)}
                  className="font-semibold text-primary transition-colors hover:text-foreground"
                >
                  Sign in
                </button>
              </>
            ) : (
              <>
                Don&apos;t have an account?{" "}
                <button
                  type="button"
                  onClick={() => setIsSignUp(true)}
                  className="font-semibold text-primary transition-colors hover:text-foreground"
                >
                  Sign up
                </button>
              </>
            )}
          </p>
        }
      >
        {expired && !isSignUp && (
          <div
            role="status"
            aria-live="polite"
            className="mb-4 rounded-lg border border-amber-500/20 bg-amber-500/10 px-3 py-2.5 text-sm leading-6 text-amber-300"
          >
            {reason}
          </div>
        )}
        <AuthProviders
          separator="or continue with email"
          providers={[
            {
              id: "google",
              label: "Continue with Google",
              icon: GoogleIcon,
              onClick: handleGoogleSignIn,
            },
          ]}
        />
        {isSignUp ? (
          <SignupForm
            onSubmit={handleSignUp}
            loading={loading}
            error={error ?? undefined}
            onToggleMode={() => setIsSignUp(false)}
            submitLabel="Create customer account"
          />
        ) : (
          <LoginForm
            onSubmit={handleSignIn}
            loading={loading}
            error={error ?? undefined}
            onToggleMode={() => setIsSignUp(true)}
            forgotPasswordHref="/forgot-password"
            submitLabel="Open customer dashboard"
          />
        )}
      </AuthCard>
    </AuthLayout>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="animate-pulse text-zinc-500">Loading...</div>
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  )
}
