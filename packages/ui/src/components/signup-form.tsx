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
}

export function SignupForm({
  onSubmit,
  loading,
  error,
  onToggleMode,
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
            className="text-sm font-medium text-[#f7f8f8]"
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
            <p id="signup-name-error" className="text-sm text-[#e5484d]">
              {errors.name.message}
            </p>
          )}
        </div>
        <div className="grid gap-1.5">
          <label
            htmlFor="signup-email"
            className="text-sm font-medium text-[#f7f8f8]"
          >
            Email
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
            <p id="signup-email-error" className="text-sm text-[#e5484d]">
              {errors.email.message}
            </p>
          )}
        </div>
        <PasswordInput
          id="signup-password"
          label="Password"
          placeholder="At least 8 characters"
          autoComplete="new-password"
          description="Must be at least 8 characters"
          error={errors.password?.message}
          {...register("password")}
        />
        {error && (
          <p className="text-sm text-[#e5484d] bg-[#e5484d]/10 border border-[#e5484d]/20 rounded-md px-3 py-2">
            {error}
          </p>
        )}
        <SpinnerButton type="submit" className="w-full h-10" loading={busy}>
          Create Account
        </SpinnerButton>
      </form>
    </div>
  )
}
