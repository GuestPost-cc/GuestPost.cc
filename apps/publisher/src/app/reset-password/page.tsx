"use client"

import { useResetPassword } from "@guestpost/auth/react"
import { AuthCard, AuthLayout, ResetPasswordForm } from "@guestpost/ui"
import { useSearchParams } from "next/navigation"
import { Suspense } from "react"

function Content() {
  const searchParams = useSearchParams()
  const token = searchParams.get("token") ?? ""
  const { submit, loading, error } = useResetPassword()

  return (
    <AuthLayout>
      <AuthCard
        title="Set New Password"
        description="Choose a new password for your account"
      >
        <ResetPasswordForm
          onSubmit={(data) => submit({ token, password: data.password })}
          loading={loading}
          error={error?.message}
        />
      </AuthCard>
    </AuthLayout>
  )
}

export default function ResetPasswordPage() {
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
