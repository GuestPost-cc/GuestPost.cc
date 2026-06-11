"use client"

import Link from "next/link"
import { useRouter, usePathname } from "next/navigation"
import { useEffect, useMemo } from "react"
import { cn } from "@guestpost/ui"
import { LayoutDashboard, Users, Building, ShoppingCart, Landmark, Settings, LogOut, Store, Newspaper, HeadphonesIcon, ScrollText } from "lucide-react"
import { useAuth } from "../../lib/auth"
import { Notifications } from "../../components/notifications"

// Per-item role allowlist mirroring the backend @StaffRoles guards: finance
// surfaces (settlements/withdrawals/payouts/reconciliation) are FINANCE +
// SUPER_ADMIN; the old boolean `adminOnly` flag locked FINANCE staff out of
// pages the API authorizes them to use.
type StaffRole = "SUPER_ADMIN" | "OPERATIONS" | "FINANCE"

const navItems: Array<{ href: string; label: string; icon: any; roles?: StaffRole[] }> = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/users", label: "Users", icon: Users },
  { href: "/dashboard/publishers", label: "Publishers", icon: Newspaper },
  { href: "/dashboard/organizations", label: "Organizations", icon: Building },
  { href: "/dashboard/orders", label: "Orders", icon: ShoppingCart },
  { href: "/dashboard/marketplace", label: "Marketplace", icon: Store, roles: ["SUPER_ADMIN", "OPERATIONS"] },
  { href: "/dashboard/finance", label: "Finance", icon: Landmark, roles: ["SUPER_ADMIN", "FINANCE"] },
  { href: "/dashboard/support", label: "Support", icon: HeadphonesIcon },
  { href: "/dashboard/audit-logs", label: "Audit Logs", icon: ScrollText, roles: ["SUPER_ADMIN"] },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
]

const ROLE_LABELS: Record<StaffRole, string> = {
  SUPER_ADMIN: "Super Admin",
  OPERATIONS: "Operations",
  FINANCE: "Finance",
}

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!loading && !user) router.push("/")
  }, [user, loading, router])

  if (loading) return <div className="flex min-h-screen items-center justify-center">Loading...</div>
  if (!user) return null

  return (
    <div className="flex min-h-screen">
      <aside className="flex w-64 flex-col border-r bg-muted/30 p-6">
        <div className="mb-8">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight">
            GuestPost Admin
          </Link>
        </div>
        <nav className="flex flex-1 flex-col gap-2">
          {navItems
            .filter(item => !item.roles || (user.staffRole && item.roles.includes(user.staffRole as StaffRole)))
            .map((item) => {
              const Icon = item.icon
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors",
                    pathname === item.href
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-4 w-4" />
                  {item.label}
                </Link>
              )
            })}
        </nav>
        <div className="border-t pt-6">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{user.name ?? user.email}</span>
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-primary/10 text-primary uppercase tracking-wider">
              {ROLE_LABELS[user.staffRole as StaffRole] ?? "Staff"}
            </span>
            <span className="ml-auto"><Notifications /></span>
          </div>
<button
            onClick={signOut}
            className="mt-2 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-3 w-3" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 p-8">{children}</main>
    </div>
  )
}
