"use client"

import type { ResetPasswordInput } from "@guestpost/shared"
import { resetPasswordSchema } from "@guestpost/shared"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { PasswordInput } from "./password-input"
import { SpinnerButton } from "./spinner-button"

export interface ResetPasswordFormProps {
  onSubmit: (data: ResetPasswordInput) => Promise<void>
  loading?: boolean
  error?: string
}

export function ResetPasswordForm({
  onSubmit,
  loading,
  error,
}: ResetPasswordFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ResetPasswordInput>({
    resolver: zodResolver(resetPasswordSchema),
  })

  const busy = loading || isSubmitting

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4" noValidate>
      <PasswordInput
        id="reset-password"
        label="New password"
        placeholder="At least 8 characters"
        autoComplete="new-password"
        required
        description="Use at least 8 characters for a secure password."
        error={errors.password?.message}
        {...register("password")}
      />
      {error && (
        <p
          role="alert"
          aria-live="assertive"
          className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm leading-6 text-destructive"
        >
          {error}
        </p>
      )}
      <SpinnerButton type="submit" className="w-full" loading={busy}>
        Reset Password
      </SpinnerButton>
    </form>
  )
}
