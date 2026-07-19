"use client"

import { Eye, EyeOff } from "lucide-react"
import * as React from "react"
import { cn } from "../lib/utils"
import { Input } from "./input"

export interface PasswordInputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "type"> {
  id: string
  label?: string
  description?: string
  error?: string
  forgotPasswordHref?: string
}

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  (
    { id, label, description, error, forgotPasswordHref, className, ...props },
    ref,
  ) => {
    const [visible, setVisible] = React.useState(false)

    return (
      <div className="grid gap-1.5">
        {label && (
          <label
            htmlFor={id}
            className="block text-xs font-semibold uppercase tracking-wider text-zinc-400 mb-2"
          >
            {label}
          </label>
        )}
        <div className="relative w-full">
          <Input
            ref={ref}
            id={id}
            type={visible ? "text" : "password"}
            className={cn("pr-10", error && "border-destructive", className)}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            {...props}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 flex items-center justify-center text-zinc-500 hover:text-zinc-300 focus:outline-none"
            aria-label={visible ? "Hide password" : "Show password"}
            tabIndex={-1}
          >
            {visible ? (
              <EyeOff className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        </div>
        {forgotPasswordHref && (
          <div className="mt-2 flex justify-end">
            <a
              href={forgotPasswordHref}
              className="text-xs text-zinc-400 hover:text-zinc-200"
            >
              Forgot password?
            </a>
          </div>
        )}
        {description && !error && (
          <p className="text-sm text-zinc-400">{description}</p>
        )}
        {error && (
          <p id={`${id}-error`} className="text-sm text-destructive">
            {error}
          </p>
        )}
      </div>
    )
  },
)
PasswordInput.displayName = "PasswordInput"

export { PasswordInput }
