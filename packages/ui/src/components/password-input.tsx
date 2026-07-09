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
}

const PasswordInput = React.forwardRef<HTMLInputElement, PasswordInputProps>(
  ({ id, label, description, error, className, ...props }, ref) => {
    const [visible, setVisible] = React.useState(false)

    return (
      <div className="grid gap-1.5">
        {label && (
          <label htmlFor={id} className="text-sm font-medium text-[#d7dce7]">
            {label}
          </label>
        )}
        <div className="relative">
          <Input
            ref={ref}
            id={id}
            type={visible ? "text" : "password"}
            className={cn("pr-10", error && "border-[#e5484d]", className)}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            {...props}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-[#7b8494] transition-colors hover:text-[#d7dce7]"
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
        {description && !error && (
          <p className="text-sm text-[#8f9aab]">{description}</p>
        )}
        {error && (
          <p id={`${id}-error`} className="text-sm text-[#ff7a7f]">
            {error}
          </p>
        )}
      </div>
    )
  },
)
PasswordInput.displayName = "PasswordInput"

export { PasswordInput }
