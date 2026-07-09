"use client"

import type { ForgotPasswordInput } from "@guestpost/shared"
import { forgotPasswordSchema } from "@guestpost/shared"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { Input } from "./input"
import { SpinnerButton } from "./spinner-button"

export interface ForgotPasswordFormProps {
  onSubmit: (data: ForgotPasswordInput) => Promise<void>
  loading?: boolean
  error?: string
  successMessage?: string
}

export function ForgotPasswordForm({
  onSubmit,
  loading,
  error,
  successMessage,
}: ForgotPasswordFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ForgotPasswordInput>({
    resolver: zodResolver(forgotPasswordSchema),
  })

  const busy = loading || isSubmitting

  return (
    <div className="grid gap-6">
      {successMessage ? (
        <p className="text-center text-sm text-emerald-400">{successMessage}</p>
      ) : (
        <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
          <p className="text-sm text-muted-foreground">
            Enter your email address and we&apos;ll send you a link to reset
            your password.
          </p>
          <div className="grid">
            <Input
              id="forgot-email"
              type="email"
              placeholder="you@example.com"
              autoComplete="email"
              aria-invalid={!!errors.email}
              aria-describedby={errors.email ? "forgot-email-error" : undefined}
              {...register("email")}
            />
            {errors.email && (
              <p
                id="forgot-email-error"
                className="mt-1.5 text-sm text-destructive"
              >
                {errors.email.message}
              </p>
            )}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <SpinnerButton type="submit" className="w-full" loading={busy}>
            Send Reset Link
          </SpinnerButton>
        </form>
      )}
    </div>
  )
}
