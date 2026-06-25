"use client"

import * as React from "react"
import { cn } from "../../lib/utils"
import { Header } from "./header"
import { Sidebar } from "./sidebar"

interface AppShellProps {
  children: React.ReactNode
  className?: string
  user?: {
    name?: string
    email?: string
    avatar?: string
  }
  onSignOut?: () => void
}

function AppShell({ children, className, user, onSignOut }: AppShellProps) {
  const [collapsed, setCollapsed] = React.useState(false)

  return (
    <div className="flex h-screen overflow-hidden bg-background">
      <Sidebar collapsed={collapsed} onCollapsedChange={setCollapsed} />
      <div className="flex flex-1 flex-col overflow-hidden">
        <Header user={user} onSignOut={onSignOut} />
        <main className={cn("flex-1 overflow-auto p-6", className)}>
          {children}
        </main>
      </div>
    </div>
  )
}

export { AppShell }
