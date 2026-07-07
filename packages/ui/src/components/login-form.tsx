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
}

export function LoginForm({
  onSubmit,
  loading,
  error,
  onToggleMode,
  forgotPasswordHref,
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
            className="text-sm font-medium text-[#f7f8f8]"
          >
            Email
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
            <p id="login-email-error" className="text-sm text-[#e5484d]">
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
          {...register("password")}
        />
        {error && (
          <p className="text-sm text-[#e5484d] bg-[#e5484d]/10 border border-[#e5484d]/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}
        <SpinnerButton type="submit" className="w-full h-10" loading={busy}>
          Sign In
        </SpinnerButton>
        {forgotPasswordHref && (
          <div className="text-center">
            <a
              href={forgotPasswordHref}
              className="text-sm text-[#8a8f98] hover:text-[#d0d6e0] transition-colors"
            >
              Forgot your password?
            </a>
          </div>
        )}
      </form>
    </div>
  )
}
