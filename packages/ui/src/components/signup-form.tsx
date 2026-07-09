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
    <div className="grid gap-5">
      <form onSubmit={handleSubmit(onSubmit)} className="grid gap-4">
        <div className="grid gap-1.5">
          <label
            htmlFor="signup-name"
            className="text-sm font-medium text-[#d7dce7]"
          >
            Full name
          </label>
          <Input
            id="signup-name"
            type="text"
            placeholder="Jane Smith"
            autoComplete="name"
            className="h-11 rounded-xl border-white/10 bg-white/[0.04]"
            aria-invalid={!!errors.name}
            aria-describedby={errors.name ? "signup-name-error" : undefined}
            {...register("name")}
          />
          {errors.name && (
            <p id="signup-name-error" className="text-sm text-[#ff7a7f]">
              {errors.name.message}
            </p>
          )}
        </div>

        <div className="grid gap-1.5">
          <label
            htmlFor="signup-email"
            className="text-sm font-medium text-[#d7dce7]"
          >
            Email address
          </label>
          <Input
            id="signup-email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            className="h-11 rounded-xl border-white/10 bg-white/[0.04]"
            aria-invalid={!!errors.email}
            aria-describedby={errors.email ? "signup-email-error" : undefined}
            {...register("email")}
          />
          {errors.email && (
            <p id="signup-email-error" className="text-sm text-[#ff7a7f]">
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
          className="h-11 rounded-xl border-white/10 bg-white/[0.04]"
          error={errors.password?.message}
          {...register("password")}
        />

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
