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
    <div className="grid gap-6">
      <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
        <div className="grid gap-1">
          <label
            htmlFor="login-email"
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
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
            <p id="login-email-error" className="text-sm text-destructive">
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
        {error && <p className="text-sm text-destructive">{error}</p>}
        <SpinnerButton type="submit" className="w-full" loading={busy}>
          Sign In
        </SpinnerButton>
      </form>

      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
        {forgotPasswordHref && (
          <a
            href={forgotPasswordHref}
            className="underline underline-offset-4 hover:text-primary"
          >
            Forgot your password?
          </a>
        )}
        {onToggleMode && (
          <button
            type="button"
            onClick={onToggleMode}
            className="underline underline-offset-4 hover:text-primary"
          >
            Don&apos;t have an account? Sign up
          </button>
        )}
      </div>
    </div>
  )
}
