"use client"

import { getErrorMessage, resetPassword } from "@guestpost/auth/client"
import {
  AuthCard,
  AuthLayout,
  type PublicAuthAudience,
  ResetPasswordForm,
} from "@guestpost/ui"
import { useSearchParams } from "next/navigation"
import { Suspense, useState } from "react"

function ResetPasswordContent() {
  const searchParams = useSearchParams()
  const token = searchParams.get("token") ?? ""
  const audience: PublicAuthAudience =
    searchParams.get("audience") === "publisher" ? "publisher" : "customer"
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (data: { password: string }) => {
    if (!token) {
      setError("This password reset link is invalid or has expired.")
      return
    }
    setLoading(true)
    setError(null)
    try {
      await resetPassword({ token, password: data.password })
      window.location.replace(`/login?audience=${audience}&reset=success`)
    } catch (err: unknown) {
      setError(getErrorMessage(err))
      setLoading(false)
    }
  }

  return (
    <AuthLayout>
      <AuthCard
        eyebrow="Account recovery"
        title="Choose a new password"
        description="Use a unique password that you do not use on another service."
      >
        <ResetPasswordForm
          onSubmit={submit}
          loading={loading}
          error={error ?? undefined}
        />
      </AuthCard>
    </AuthLayout>
  )
}

export default function WebsiteResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordContent />
    </Suspense>
  )
}
