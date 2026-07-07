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
import { useSession, useSignIn, useSignUp } from "@guestpost/auth/react"
import {
  AuthCard,
  AuthLayout,
  AuthProviders,
  LoginForm,
  SignupForm,
  useSessionExpired,
} from "@guestpost/ui"
import { useRouter, useSearchParams } from "next/navigation"
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

function LoginContent() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isSignUp, setIsSignUp] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const { expired, reason, dismiss } = useSessionExpired()
  const { signIn: hookSignIn, loading: signInLoading } = useSignIn()
  const { signUp: hookSignUp, loading: signUpLoading } = useSignUp()
  const { session: _session, user } = useSession()

  const loading = isSignUp ? signUpLoading : signInLoading

  useEffect(() => {
    if (searchParams.get("signup") === "true") {
      setIsSignUp(true)
    }
  }, [searchParams])

  // Redirect already-authenticated CUSTOMER users away from the login page.
  // Must also hydrate the Bearer token (setToken) for the HttpClient-based
  // dashboard — otherwise POST requests (create org, etc.) are blocked by
  // the CSRF middleware.
  //
  // Only redirect when user is confirmed CUSTOMER (not when user is null,
  // which would mean the session hasn't loaded yet). The old `user === null`
  // branch caused a redirect loop: login page could redirect before the
  // dashboard layout had its token, dashboard would see no user and bounce
  // back to /, restarting the cycle.
  useEffect(() => {
    if (user?.userType !== "CUSTOMER") return

    const redirectWithToken = async () => {
      const sessionResult = await getSession()
      if (!sessionResult?.token) return

      setToken(sessionResult.token)

      const returnTo = searchParams.get("returnTo")
      const safeReturnTo =
        returnTo && returnTo !== "/" ? returnTo : "/dashboard"
      router.push(safeReturnTo)
    }

    redirectWithToken()
  }, [user, searchParams, router])

  const handleGoogleSignIn = async () => {
    try {
      await signInWithProvider("google", window.location.origin)
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
    try {
      const result = await signInTransport(data)
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
      if (!session?.user || session.user.userType !== "CUSTOMER") {
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
      if (!session?.user || session.user.userType !== "CUSTOMER") {
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
        <AuthProviders
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
