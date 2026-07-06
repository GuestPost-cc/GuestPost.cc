"use client"

import type { AuthError } from "@guestpost/auth"
import {
  getErrorMessage,
  isAuthError,
  signIn as signInTransport,
  signUp as signUpTransport,
} from "@guestpost/auth/client"
import { useSignIn, useSignUp } from "@guestpost/auth/react"
import {
  AuthCard,
  AuthLayout,
  LoginForm,
  SignupForm,
  useSessionExpired,
} from "@guestpost/ui"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"

function LoginContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isSignUp, setIsSignUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { expired, reason, dismiss } = useSessionExpired()
  const { signIn: hookSignIn, loading: signInLoading } = useSignIn()
  const { signUp: hookSignUp, loading: signUpLoading } = useSignUp()

  const loading = isSignUp ? signUpLoading : signInLoading

  useEffect(() => {
    if (searchParams.get("signup") === "true") {
      setIsSignUp(true)
    }
  }, [searchParams])

  const handleSignIn = async (data: { email: string; password: string }) => {
    setError(null)
    try {
      const result = await signInTransport(data)
      if (result.status === "mfa_required") {
        throw {
          code: "MFA_REQUIRED",
          message:
            "Multi-factor authentication is required. Please complete verification.",
          recoverable: true,
        } as AuthError
      }
      if (result.user.userType !== "CUSTOMER") {
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
      router.push(safeReturnTo)
    } catch (err: any) {
      setError(
        isAuthError(err)
          ? getErrorMessage(err)
          : (err.message ?? "Something went wrong"),
      )
    }
  }

  const handleSignUp = async (data: {
    name: string
    email: string
    password: string
  }) => {
    setError(null)
    try {
      const result = await signUpTransport(data)
      if (result.status === "mfa_required") {
        throw {
          code: "MFA_REQUIRED",
          message:
            "Multi-factor authentication is required. Please complete verification.",
          recoverable: true,
        } as AuthError
      }
      if (result.user.userType !== "CUSTOMER") {
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
      router.push(safeReturnTo)
    } catch (err: any) {
      setError(
        isAuthError(err)
          ? getErrorMessage(err)
          : (err.message ?? "Something went wrong"),
      )
    }
  }

  return (
    <AuthLayout>
      <AuthCard
        title={isSignUp ? "SEO Expert Sign Up" : "SEO Expert Sign In"}
        description={
          isSignUp
            ? "Create an account to manage your campaigns"
            : "Sign in to your GuestPost account"
        }
        footer={
          <div className="space-y-2">
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
            <p className="text-center text-sm text-muted-foreground">
              <a
                href={process.env.NEXT_PUBLIC_WEBSITE_URL || "/"}
                className="underline underline-offset-4 hover:text-primary"
              >
                Back to homepage
              </a>
            </p>
          </div>
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
