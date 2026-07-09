"use client"

import type { SignupInput } from "@guestpost/shared"
import { signupSchema } from "@guestpost/shared"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { Input } from "./input"
import { PasswordInput } from "./password-input"
import { SpinnerButton } from "./spinner-button"

export interface SignupFormProps {
  onSubmit: (data: SignupInput) => Promise<void>
  loading?: boolean
  error?: string
  onToggleMode?: () => void
  submitLabel?: string
}

export function SignupForm({
  onSubmit,
  loading,
  error,
  submitLabel = "Create account",
}: SignupFormProps) {
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<SignupInput>({
    resolver: zodResolver(signupSchema),
  })

  const busy = loading || isSubmitting

  return (
    <div>
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-4">
        <div>
          <label
            htmlFor="signup-name"
            className="block text-xs font-medium uppercase tracking-wider text-zinc-400 pb-[5px]"
          >
            Full name
          </label>
          <Input
            id="signup-name"
            type="text"
            placeholder="Jane Smith"
            autoComplete="name"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "signup-name-error" : undefined}
            {...register("name")}
          />
          {errors.name && (
            <p
              id="signup-name-error"
              className="mt-1.5 text-sm text-destructive"
            >
              {errors.name.message}
            </p>
          )}
        </div>

        <div>
          <label
            htmlFor="signup-email"
            className="block text-xs font-medium uppercase tracking-wider text-zinc-400 pb-[5px]"
          >
            Email address
          </label>
          <Input
            id="signup-email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "signup-email-error" : undefined}
            {...register("email")}
          />
          {errors.email && (
            <p
              id="signup-email-error"
              className="mt-1.5 text-sm text-destructive"
            >
              {errors.email.message}
            </p>
          )}
        </div>

        <PasswordInput
          id="signup-password"
          label="Password"
          placeholder="At least 8 characters"
          autoComplete="new-password"
          description="Use at least 8 characters for a secure password."
          error={errors.password?.message}
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
