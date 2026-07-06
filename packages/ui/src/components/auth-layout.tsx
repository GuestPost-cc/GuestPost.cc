import type * as React from "react"
import { cn } from "../lib/utils"

export interface AuthLayoutProps {
  children: React.ReactNode
  logo?: React.ReactNode
}

export function AuthLayout({ children, logo }: AuthLayoutProps) {
  return (
    <div
      className={cn(
        "flex min-h-screen flex-col items-center justify-center",
        "bg-background",
      )}
    >
      {logo && <div className="mb-8">{logo}</div>}
      {children}
    </div>
  )
}
