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
      <div className="grid gap-1">
        {label && (
          <label htmlFor={id} className="text-sm text-foreground">
            {label}
          </label>
        )}
        <div className="relative">
          <Input
            ref={ref}
            id={id}
            type={visible ? "text" : "password"}
            className={cn("pr-12", error && "border-destructive", className)}
            aria-invalid={!!error}
            aria-describedby={error ? `${id}-error` : undefined}
            {...props}
          />
          <button
            type="button"
            onClick={() => setVisible((v) => !v)}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
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
          <p className="text-sm text-muted-foreground">{description}</p>
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
