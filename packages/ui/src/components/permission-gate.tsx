"use client"

import type * as React from "react"

interface PermissionGateProps {
  requiredPermission: string
  userPermissions?: string[]
  children: React.ReactNode
  fallback?: React.ReactNode
}

function PermissionGate({
  requiredPermission,
  userPermissions = [],
  children,
  fallback = null,
}: PermissionGateProps) {
  const hasPermission = userPermissions.includes(requiredPermission)

  if (!hasPermission) {
    return <>{fallback}</>
  }

  return <>{children}</>
}

export { PermissionGate }
