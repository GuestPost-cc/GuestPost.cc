"use client"

import { useState, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"
import { Button } from "@guestpost/ui"
import { sanitizeReturnTo } from "@guestpost/api-client"
import { useAuth } from "../lib/auth"

export default function LoginPage() {
  const { signIn, user, loading: authLoading } = useAuth()
  const router = useRouter()
  const searchParams = useSearchParams()
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")
  const [error, setError] = useState("")
  const [submitting, setSubmitting] = useState(false)
  // Phase 6.8 — sessionStorage-stashed reason from the 401-redirect handler.
  const [sessionExpiredBanner, setSessionExpiredBanner] = useState<string | null>(null)

  // Phase 6.8 — sanitize returnTo once + reuse for both the auto-redirect
  // (already-signed-in user lands on this page with returnTo) and post-submit.
  const safeReturnTo = (() => {
    const raw = searchParams.get("returnTo")
    const sanitized = sanitizeReturnTo(raw)
    return sanitized && sanitized !== "/" ? sanitized : "/dashboard"
  })()

  useEffect(() => {
    if (!authLoading && user?.userType === "STAFF") {
      router.push(safeReturnTo)
    }
  }, [user, authLoading, router, safeReturnTo])

  useEffect(() => {
    try {
      const reason = sessionStorage.getItem("guestpost:auth-redirect-reason")
      if (reason) {
        setSessionExpiredBanner(reason)
        sessionStorage.removeItem("guestpost:auth-redirect-reason")
      }
    } catch { /* private mode */ }
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError("")
    setSubmitting(true)
    try {
      await signIn(email, password)
      router.push(safeReturnTo)
    } catch (err: any) {
      setError(err.message ?? "Authentication failed")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="mx-auto flex w-full max-w-md flex-col justify-center space-y-6 p-8">
        <div className="flex flex-col space-y-2 text-center">
          <h1 className="text-2xl font-semibold tracking-tight">
            Admin Sign In
          </h1>
          <p className="text-sm text-muted-foreground">
            Sign in to manage the platform
          </p>
        </div>

        {sessionExpiredBanner && (
          <div
            role="status"
            aria-live="polite"
            className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900"
          >
            {sessionExpiredBanner}
          </div>
        )}

        <form onSubmit={handleSubmit} className="grid gap-4">
          <input
            type="email"
            placeholder="Email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            required
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background file:border-0 file:bg-transparent file:text-sm file:font-medium placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
            required
          />
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Loading..." : "Sign In"}
          </Button>
        </form>
      </div>
    </div>
  )
}