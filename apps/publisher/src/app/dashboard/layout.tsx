"use client"

import { cn, Drawer, DrawerContent, DrawerTitle } from "@guestpost/ui"
import {
  ArrowUpRight,
  CreditCard,
  DollarSign,
  Globe,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings,
  ShoppingCart,
  Store,
  Wallet,
  X,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { Notifications } from "../../components/notifications"
import { useAuth } from "../../lib/auth"

const navItems = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/orders", label: "Orders", icon: ShoppingCart },
  { href: "/dashboard/websites", label: "Websites", icon: Globe },
  { href: "/dashboard/listings", label: "Listings", icon: Store },
  { href: "/dashboard/earnings", label: "Earnings", icon: DollarSign },
  { href: "/dashboard/withdrawals", label: "Withdrawals", icon: Wallet },
  {
    href: "/dashboard/payout-methods",
    label: "Payout Methods",
    icon: CreditCard,
  },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
]

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { user, loading, signOut } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  const hasSeenLoadingFalse = useRef(false)

  useEffect(() => {
    if (loading) return
    if (!hasSeenLoadingFalse.current) {
      hasSeenLoadingFalse.current = true
      return
    }
    if (!user) router.push("/")
  }, [user, loading, router])

  // Pathname-auto-close — closes mobile drawer on navigation
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on pathname change to close drawer
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  if (loading)
    return (
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
      <div className="flex h-full flex-col p-6">
        <div className="mb-8 flex items-center justify-between">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-lg font-bold tracking-tight"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
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
        <nav className="flex flex-1 flex-col gap-1 overflow-y-auto">
          {navItems.map((item) => {
            const Icon = item.icon
            const isActive =
              pathname === item.href ||
              (item.href !== "/dashboard" && pathname.startsWith(item.href))
            return (
              <Link
                key={item.href}
                href={item.href}
                className={cn(
                  "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200",
                  isActive
                    ? "bg-primary/10 text-primary"
                    : "text-muted-foreground hover:bg-surface-1 hover:text-foreground",
                )}
              >
                <Icon className="h-4 w-4 shrink-0" />
                {item.label}
              </Link>
            )
          })}
        </nav>
        <div className="border-t pt-6">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium">{u.name ?? u.email}</span>
            <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-primary/10 text-primary uppercase tracking-wider">
              Publisher
            </span>
            <span className="ml-auto">
              <Notifications />
            </span>
          </div>
          <button
            type="button"
            onClick={signOut}
            className="mt-2 flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
          >
            <LogOut className="h-3 w-3" />
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
        <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b bg-background px-4 lg:hidden">
          <button
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="Open menu"
          >
            <Menu className="h-5 w-5" />
          </button>
          <Link href="/dashboard" className="font-semibold">
            GuestPost
          </Link>
        </header>
        <main className="flex-1 overflow-auto">
          <div className="mx-auto max-w-7xl p-8">{children}</div>
        </main>
      </div>
    </div>
  )
}
