"use client"

import * as React from "react"

interface RoleGuardProps {
  allowedRoles: string[]
  userRole?: string
  children: React.ReactNode
  fallback?: React.ReactNode
}

function RoleGuard({ allowedRoles, userRole = "", children, fallback = null }: RoleGuardProps) {
  const hasRole = allowedRoles.includes(userRole)

  if (!hasRole) {
    return <>{fallback}</>
  }

  return <>{children}</>
}

export { RoleGuard }