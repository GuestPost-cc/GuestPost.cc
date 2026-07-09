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
    <div className="grid gap-5">
      <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
        <div className="grid gap-1.5">
          <label
            htmlFor="login-email"
            className="text-sm font-medium text-[#d7dce7]"
          >
            Email address
          </label>
          <Input
            id="login-email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            className="h-11 rounded-xl border-white/10 bg-white/[0.04]"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "login-email-error" : undefined}
            {...register("email")}
          />
          {errors.email && (
            <p id="login-email-error" className="text-sm text-[#ff7a7f]">
              {errors.email.message}
            </p>
          )}
        </div>

        <PasswordInput
          id="login-password"
          label="Password"
          placeholder="Enter your password"
          autoComplete="current-password"
          className="h-11 rounded-xl border-white/10 bg-white/[0.04]"
          error={errors.password?.message}
          {...register("password")}
        />

        {forgotPasswordHref && (
          <div className="-mt-1 text-right">
            <a
              href={forgotPasswordHref}
              className="text-sm font-medium text-[#aeb7ff] transition-colors hover:text-white"
            >
              Forgot password?
            </a>
          </div>
        )}

        {error && (
          <p
            role="alert"
            className="rounded-xl border border-[#e5484d]/25 bg-[#e5484d]/10 px-3 py-2.5 text-sm leading-6 text-[#ffb3b6]"
          >
            {error}
          </p>
        )}

        <SpinnerButton
          type="submit"
          className="mt-1 h-11 w-full rounded-xl bg-gradient-to-r from-[#5e6ad2] to-[#8b5cf6] font-semibold shadow-lg shadow-[#5e6ad2]/25 transition-all hover:-translate-y-0.5 hover:from-[#6f79e8] hover:to-[#9b6cff]"
          loading={busy}
        >
          {submitLabel}
        </SpinnerButton>
      </form>
    </div>
  )
}
