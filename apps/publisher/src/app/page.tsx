"use client"

import type { AuthError } from "@guestpost/auth"
import {
  getErrorMessage,
  isAuthError,
  signIn as signInTransport,
  signUp as signUpTransport,
} from "@guestpost/auth/client"
import {
  AuthCard,
  AuthLayout,
  LoginForm,
  SignupForm,
  useSessionExpired,
} from "@guestpost/ui"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"

function getBaseUrl(): string {
  const envUrl = process.env.NEXT_PUBLIC_API_URL
  if (envUrl) return envUrl
  if (typeof window !== "undefined") {
    const host = window.location.hostname
    if (host !== "localhost" && host !== "127.0.0.1")
      return `http://${host}:4000`
  }
  return "http://localhost:4000"
}

function LoginContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isSignUp, setIsSignUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const { expired, reason, dismiss } = useSessionExpired()

  useEffect(() => {
    try {
      const r = sessionStorage.getItem("guestpost:auth-redirect-reason")
      if (r) {
        setError(r)
        sessionStorage.removeItem("guestpost:auth-redirect-reason")
      }
    } catch {
      /* private mode */
    }
  }, [])

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
      if (result.user.userType !== "PUBLISHER") {
        throw {
          code: "WRONG_AUDIENCE",
          message:
            "This portal is for publishers only. Please sign in at the correct portal.",
          recoverable: true,
        } as AuthError
      }
      const returnTo = searchParams.get("returnTo")
      const safeReturnTo =
        returnTo && returnTo !== "/" ? returnTo : "/dashboard"
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

  const handleSignUp = async (data: {
    name: string
    email: string
    password: string
  }) => {
    setError(null)
    setLoading(true)
    try {
      const result = await signUpTransport(data)
      if (result.status === "mfa_required") {
        throw {
          code: "MFA_REQUIRED",
          message: "Multi-factor authentication is required.",
          recoverable: true,
        } as AuthError
      }

      // Convert to publisher
      const convertRes = await fetch(
        `${getBaseUrl()}/api/v1/identity/become-publisher`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          credentials: "include",
          body: JSON.stringify({ publisherName: data.name }),
        },
      )
      if (!convertRes.ok) {
        const errData = await convertRes.json().catch(() => ({}))
        throw {
          code: "CONVERSION_FAILED",
          message:
            errData.message ?? "Could not set up your publisher account.",
          recoverable: true,
        } as AuthError
      }

      const returnTo = searchParams.get("returnTo")
      const safeReturnTo =
        returnTo && returnTo !== "/" ? returnTo : "/dashboard"
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

  return (
    <AuthLayout>
      <AuthCard
        title={isSignUp ? "Publisher Sign Up" : "Publisher Sign In"}
        description={
          isSignUp
            ? "Create an account to start publishing"
            : "Sign in to manage your orders and content"
        }
        footer={
          <p className="text-center text-sm text-muted-foreground">
            {isSignUp ? (
              <>
                Already have an account?{" "}
                <button
                  onClick={() => setIsSignUp(false)}
                  className="underline underline-offset-4 hover:text-primary"
                >
                  Sign in
                </button>
              </>
            ) : (
              <>
                Don&apos;t have an account?{" "}
                <button
                  onClick={() => setIsSignUp(true)}
                  className="underline underline-offset-4 hover:text-primary"
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
            className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {reason}
          </div>
        )}
        {isSignUp ? (
          <SignupForm
            onSubmit={handleSignUp}
            loading={loading}
            error={error ?? undefined}
            onToggleMode={() => setIsSignUp(false)}
          />
        ) : (
          <LoginForm
            onSubmit={handleSignIn}
            loading={loading}
            error={error ?? undefined}
            onToggleMode={() => setIsSignUp(true)}
            forgotPasswordHref="/forgot-password"
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
          <div className="animate-pulse text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  )
}
