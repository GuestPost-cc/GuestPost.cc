"use client"

import Link from "next/link"
import { useRouter, usePathname } from "next/navigation"
import { useEffect } from "react"
import { cn } from "@guestpost/ui"
import {
  LayoutDashboard,
  ShoppingCart,
  DollarSign,
  LogOut,
  Globe,
  Wallet,
  CreditCard,
  Settings,
  ArrowUpRight,
  Store,
} from "lucide-react"
import { useAuth } from "../../lib/auth"
import { Notifications } from "../../components/notifications"

const navItems = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/orders", label: "Orders", icon: ShoppingCart },
  { href: "/dashboard/websites", label: "Websites", icon: Globe },
  { href: "/dashboard/listings", label: "Listings", icon: Store },
  { href: "/dashboard/earnings", label: "Earnings", icon: DollarSign },
  { href: "/dashboard/withdrawals", label: "Withdrawals", icon: Wallet },
  { href: "/dashboard/payout-methods", label: "Payout Methods", icon: CreditCard },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
]

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { user, loading, signOut } = useAuth()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!loading && !user) router.push("/")
  }, [user, loading, router])

  if (loading) return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  )
  if (!user) return null

  return (
    <div className="flex min-h-screen">
      {/* Fixed viewport-height column: stays put regardless of page length or
          any ancestor overflow/transform (sticky is fragile against those).
          Content offset by lg:ml-64. Nav scrolls internally on short screens. */}
      <aside className="sticky top-0 z-40 flex h-screen w-64 shrink-0 flex-col border-r bg-muted/30 lg:fixed lg:inset-y-0 lg:left-0">
        <div className="flex items-center justify-between border-b px-6 py-5">
          <Link href="/dashboard" className="flex items-center gap-2 font-bold tracking-tight">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ArrowUpRight className="h-4 w-4" />
            </div>
            GuestPost
          </Link>
        </div>
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto p-4">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive = pathname === item.href || (item.href !== "/dashboard" && pathname.startsWith(item.href))
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm transition-colors",
                  isActive
                    ? "bg-primary/10 text-primary font-medium"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="border-t p-4">
          <div className="flex items-center gap-2 rounded-lg bg-card p-3">
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{user.name ?? user.email}</p>
              <p className="text-xs text-muted-foreground">Publisher</p>
            </div>
            <Notifications />
          </div>
          <button
            onClick={signOut}
            className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="flex-1 overflow-auto lg:ml-64">
        <div className="mx-auto max-w-7xl p-8">{children}</div>
      </main>
    </div>
  )
}