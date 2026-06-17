"use client"

import Link from "next/link"
import { useRouter, usePathname } from "next/navigation"
import { useEffect, useState } from "react"
import { cn, Drawer, DrawerContent, DrawerTitle } from "@guestpost/ui"
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
  Menu,
  X,
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
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    if (!loading && !user) router.push("/")
  }, [user, loading, router])

  // Pathname-auto-close — lives at the layout level so @guestpost/ui
  // stays framework-agnostic.
  useEffect(() => { setMobileOpen(false) }, [pathname])

  if (loading) return (
    <div className="flex min-h-screen items-center justify-center">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
    </div>
  )
  if (!user) return null
  // Local non-null alias so the nested SidebarContents closure has a
  // narrowed type without each ref needing a `!` non-null assertion.
  const u = user

  function SidebarContents({ inDrawer = false }: { inDrawer?: boolean }) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b px-6 py-5">
          <Link href="/dashboard" className="flex items-center gap-2 font-bold tracking-tight">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <ArrowUpRight className="h-4 w-4" />
            </div>
            GuestPost
          </Link>
          {inDrawer && (
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
            >
              <X className="h-5 w-5" />
            </button>
          )}
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
              <p className="truncate text-sm font-medium">{u.name ?? u.email}</p>
              <p className="text-xs text-muted-foreground">Publisher</p>
            </div>
            <Notifications />
          </div>
          <button
            type="button"
            onClick={signOut}
            className="mt-2 flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="flex min-h-screen">
      {/* Desktop sidebar — static <aside>, lg+ only. */}
      <aside className="hidden lg:flex fixed inset-y-0 left-0 z-50 h-screen w-64 flex-col border-r bg-muted/30">
        <SidebarContents />
      </aside>

      {/* Mobile drawer — Phase 7.6.1 a11y from Radix Dialog. */}
      <Drawer open={mobileOpen} onOpenChange={setMobileOpen}>
        <DrawerContent side="left" className="bg-muted/30">
          <DrawerTitle className="sr-only">Navigation</DrawerTitle>
          <SidebarContents inDrawer />
        </DrawerContent>
      </Drawer>

      <div className="flex-1 flex flex-col min-w-0 lg:pl-64">
        <header className="sticky top-0 z-30 flex h-16 items-center gap-4 border-b bg-background/95 px-6 backdrop-blur supports-[backdrop-filter]:bg-background/60 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <span className="font-semibold">GuestPost</span>
        </header>
        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-7xl p-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
