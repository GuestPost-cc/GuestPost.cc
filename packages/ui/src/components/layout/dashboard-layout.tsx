"use client"

import * as React from "react"
import { cn } from "../../lib/utils"
import { AppShell } from "./app-shell"

interface DashboardLayoutProps {
  children: React.ReactNode
  className?: string
  user?: {
    name?: string
    email?: string
    avatar?: string
  }
  onSignOut?: () => void
}

function DashboardLayout({ children, className, user, onSignOut }: DashboardLayoutProps) {
  return (
    <AppShell user={user} onSignOut={onSignOut}>
      <div className={cn("mx-auto max-w-7xl", className)}>{children}</div>
    </AppShell>
  )
}

export { DashboardLayout }