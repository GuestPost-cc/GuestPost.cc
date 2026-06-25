"use client"

import { useRouter } from "next/navigation"
import * as React from "react"

interface ProtectedRouteProps {
  children: React.ReactNode
  isAuthenticated: boolean
  isLoading?: boolean
  loginPath?: string
}

function ProtectedRoute({
  children,
  isAuthenticated,
  isLoading = false,
  loginPath = "/",
}: ProtectedRouteProps) {
  const router = useRouter()

  React.useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      router.push(loginPath)
    }
  }, [isAuthenticated, isLoading, loginPath, router])

  if (isLoading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  if (!isAuthenticated) {
    return null
  }

  return <>{children}</>
}

export { ProtectedRoute }
