"use client"

import { sanitizeReturnTo } from "@guestpost/api-client"
import { Button } from "@guestpost/ui"
import { zodResolver } from "@hookform/resolvers/zod"
import { useRouter, useSearchParams } from "next/navigation"
import { Suspense, useEffect, useState } from "react"
import { useForm } from "react-hook-form"
import { z } from "zod"
import { useAuth } from "../lib/auth"

function LoginContent() {
  const { signIn, signUp } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [isSignUp, setIsSignUp] = useState(false)
  const [name, setName] = useState("")
  const [error, setError] = useState("")
  // Phase 6.8 — banner copy stashed by the 401-redirect handler.
  const [sessionExpiredBanner, setSessionExpiredBanner] = useState<
    string | null
  >(null)

  const loginSchema = z.object({
    email: z.string().email("Valid email required"),
    password: z.string().min(6, "At least 6 characters"),
  })

  type LoginFormData = z.infer<typeof loginSchema>

  const {
    register,
    handleSubmit: handleFormSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginFormData>({
    resolver: zodResolver(loginSchema),
  })

  useEffect(() => {
    try {
      const reason = sessionStorage.getItem("guestpost:auth-redirect-reason")
      if (reason) {
        setSessionExpiredBanner(reason)
        sessionStorage.removeItem("guestpost:auth-redirect-reason")
      }
    } catch {
      /* private mode */
    }
  }, [])

  const onSubmit = async (data: LoginFormData) => {
    setError("")
    try {
      if (isSignUp) {
        await signUp(data.email, data.password, name)
      } else {
        await signIn(data.email, data.password)
      }
      // Phase 6.8 — honor sanitized returnTo so the user lands back where
      // the 401 bounced them. The sanitizer rejects cross-origin paths.
      const safeReturnTo = sanitizeReturnTo(searchParams.get("returnTo"))
      router.push(
        safeReturnTo && safeReturnTo !== "/" ? safeReturnTo : "/dashboard",
      )
    } catch (err: any) {
      setError(err.message ?? "Something went wrong")
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="mx-auto flex w-full flex-col justify-center space-y-6 sm:w-[400px]">
        <div className="flex flex-col space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            {isSignUp ? "Publisher Sign Up" : "Publisher Sign In"}
          </h1>
          <p className="text-sm text-muted-foreground">
            {isSignUp
              ? "Create an account to start publishing"
              : "Sign in to manage your orders and content"}
          </p>
        </div>

        {sessionExpiredBanner && !isSignUp && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {sessionExpiredBanner}
          </div>
        )}

        <form onSubmit={handleFormSubmit(onSubmit)} className="grid gap-4">
          {isSignUp && (
            <input
              type="text"
              placeholder="Full name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
              required
            />
          )}
          <input
            type="email"
            placeholder="Email"
            {...register("email")}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            required
          />
          {errors.email && (
            <p className="text-sm text-destructive">{errors.email.message}</p>
          )}
          <input
            type="password"
            placeholder="Password"
            {...register("password")}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            required
          />
          {errors.password && (
            <p className="text-sm text-destructive">
              {errors.password.message}
            </p>
          )}
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting
              ? "Loading..."
              : isSignUp
                ? "Create Account"
                : "Sign In"}
          </Button>
        </form>

        <div className="space-y-4">
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
      </div>
    </div>
  )
}

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          Loading...
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  )
}
