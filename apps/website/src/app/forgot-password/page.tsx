"use client"

import { forgotPassword, getErrorMessage } from "@guestpost/auth/client"
import {
  AuthCard,
  AuthLayout,
  ForgotPasswordForm,
  type PublicAuthAudience,
} from "@guestpost/ui"
import Link from "next/link"
import { useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"

function ForgotPasswordContent() {
  const searchParams = useSearchParams()
  const audience: PublicAuthAudience =
    searchParams.get("audience") === "publisher" ? "publisher" : "customer"
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState(false)

  const submit = async ({ email }: { email: string }) => {
    setLoading(true)
    setError(null)
    try {
      const resetUrl = new URL("/reset-password", window.location.origin)
      resetUrl.searchParams.set("audience", audience)
      await forgotPassword({ email, redirectTo: resetUrl.toString() })
      setSuccess(true)
    } catch (err: unknown) {
      setError(getErrorMessage(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <AuthLayout>
      <AuthCard
        eyebrow="Account recovery"
        title="Reset your password"
        description="Enter your email and we’ll send a secure, single-use reset link if an account exists."
        footer={
          <Link
            href={`/login?audience=${audience}`}
            className="font-semibold text-sky-300 hover:text-sky-200"
          >
            Back to login
          </Link>
        }
      >
        <ForgotPasswordForm
          onSubmit={submit}
          loading={loading}
          error={error ?? undefined}
          successMessage={
            success
              ? "If an account exists for that email, a reset link is on its way."
              : undefined
          }
        />
      </AuthCard>
    </AuthLayout>
  )
}

export default function WebsiteForgotPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ForgotPasswordContent />
    </Suspense>
  )
}
