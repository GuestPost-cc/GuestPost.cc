"use client"

import { useAuth } from "./auth"
import { Button } from "@guestpost/ui"
import { ShieldAlert } from "lucide-react"
import Link from "next/link"

type StaffRole = "SUPER_ADMIN" | "OPERATIONS" | "FINANCE"

// Page-level guard mirroring the backend @StaffRoles decorators. The API is
// the real boundary (it returns 403 regardless) — this gives an honest
// "no access" page instead of a wall of failed requests, and stops staff
// from deep-linking into screens their role can't use.
export function useRequireRole(...roles: StaffRole[]) {
  const { user, loading } = useAuth()
  const allowed = !loading && !!user?.staffRole && roles.includes(user.staffRole as StaffRole)
  return { allowed, loading, user }
}

export function ForbiddenPage({ requires }: { requires: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center">
      <ShieldAlert className="h-12 w-12 text-destructive mb-4" />
      <h2 className="text-xl font-semibold mb-2">Access restricted</h2>
      <p className="text-muted-foreground mb-4">This area requires the {requires} role.</p>
      <Button asChild variant="outline"><Link href="/dashboard">Back to overview</Link></Button>
    </div>
  )
}
