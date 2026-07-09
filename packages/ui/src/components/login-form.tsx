"use client"

import type { LoginInput } from "@guestpost/shared"
import { loginSchema } from "@guestpost/shared"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { Input } from "./input"
import { PasswordInput } from "./password-input"
import { SpinnerButton } from "./spinner-button"

export interface LoginFormProps {
  onSubmit: (data: LoginInput) => Promise<void>
  loading?: boolean
  error?: string
  onToggleMode?: () => void
  forgotPasswordHref?: string
  submitLabel?: string
}

export function LoginForm({
  onSubmit,
  loading,
  error,
  forgotPasswordHref,
  submitLabel = "Sign in",
}: LoginFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
  })

  const busy = loading || isSubmitting

  return (
    <div>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label
            htmlFor="login-email"
            className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2"
          >
            Email address
          </label>
          <Input
            id="login-email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "login-email-error" : undefined}
            {...register("email")}
          />
          {errors.email && (
            <p
              id="login-email-error"
              className="mt-1.5 text-sm text-destructive"
            >
              {errors.email.message}
            </p>
          )}
        </div>

        <PasswordInput
          id="login-password"
          label="Password"
          placeholder="Enter your password"
          autoComplete="current-password"
          error={errors.password?.message}
          forgotPasswordHref={forgotPasswordHref}
          {...register("password")}
        />

        {error && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/25 bg-destructive/10 px-3 py-2.5 text-sm leading-6 text-destructive"
          >
            {error}
          </p>
        )}

        <SpinnerButton type="submit" className="mt-4 w-full" loading={busy}>
          {submitLabel}
        </SpinnerButton>
      </form>
    </div>
  )
}
