"use client"

import { useForgotPassword } from "@guestpost/auth/react"
import { AuthCard, AuthLayout, ForgotPasswordForm } from "@guestpost/ui"
import { Suspense } from "react"

function Content() {
  const { submit, loading, error, success } = useForgotPassword()

  return (
    <AuthLayout>
      <AuthCard
        title="Reset Password"
        description="Enter your email and we'll send you a reset link"
      >
        <ForgotPasswordForm
          onSubmit={submit}
          loading={loading}
          error={error?.message}
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

export default function ForgotPasswordPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <div className="animate-pulse text-muted-foreground">Loading...</div>
        </div>
      }
    >
      <Content />
    </Suspense>
  )
}
