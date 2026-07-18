"use client"

import { Skeleton } from "@guestpost/ui"
import { useAuth } from "../../lib/auth"
import { FinanceWorkbench } from "./_components/finance-workbench"
import { OperationsWorkbench } from "./_components/operations-workbench"
import { SuperAdminCommandCenter } from "./_components/super-admin-command-center"

export default function DashboardPage() {
  const { user, loading } = useAuth()
  if (loading) return <Skeleton className="h-72 w-full" />
  if (user?.staffRole === "SUPER_ADMIN") return <SuperAdminCommandCenter />
  if (user?.staffRole === "OPERATIONS") return <OperationsWorkbench />
  return <FinanceWorkbench />
}
