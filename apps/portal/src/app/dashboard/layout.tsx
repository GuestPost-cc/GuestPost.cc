"use client"

import { cn, Drawer, DrawerContent, DrawerTitle } from "@guestpost/ui"
import {
  BarChart3,
  Bookmark,
  Building2,
  CreditCard,
  HeadphonesIcon,
  Heart,
  LayoutDashboard,
  LogOut,
  Megaphone,
  Menu,
  Settings,
  ShoppingCart,
  Store,
  X,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { CreateOrgGate } from "../../components/create-org-gate"
import { EmailVerificationBannerContainer } from "../../components/email-verification-banner-container"
import { Notifications } from "../../components/notifications"
import { OrgSwitcher } from "../../components/org-switcher"
import { useAuth } from "../../lib/auth"

// ownerOnly items hit OWNER-gated backend routes (wallet deposit/checkout/
// withdraw, org member/team management) — hiding them from MEMBER avoids
// dead links that 403. The API enforces the boundary regardless.
const navItems = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/campaigns", label: "Campaigns", icon: Megaphone },
  { href: "/dashboard/orders", label: "Orders", icon: ShoppingCart },
  { href: "/dashboard/marketplace", label: "Marketplace", icon: Store },
  { href: "/dashboard/marketplace/favorites", label: "Favorites", icon: Heart },
  {
    href: "/dashboard/marketplace/saved-lists",
    label: "Saved Lists",
    icon: Bookmark,
  },
  { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
  {
    href: "/dashboard/billing",
    label: "Billing",
    icon: CreditCard,
    ownerOnly: true,
  },
  {
    href: "/dashboard/settings/organization",
    label: "Organization",
    icon: Building2,
  },
  { href: "/dashboard/support", label: "Support", icon: HeadphonesIcon },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
]

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { user, loading, signOut, refresh } = useAuth()
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
        <div className="flex flex-col items-center gap-4">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  if (!user) return null

  // No organization yet: every money action would 403 — onboard first
  if (!user.organizationId) {
    return <CreateOrgGate onCreated={() => refresh()} />
  }

  // Local non-null alias for the nested SidebarContents closure.
  const u = user

  function SidebarContents({ inDrawer = false }: { inDrawer?: boolean }) {
    return (
      <div className="flex h-full flex-col p-6">
        <div className="mb-8 flex items-center justify-between">
          <Link
            href="/dashboard"
            className="flex items-center gap-2 text-lg font-bold tracking-tight"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground">
              <span className="text-sm font-bold">GP</span>
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
          {(() => {
            const visible = navItems.filter(
              (item) => !item.ownerOnly || u.customerRole === "OWNER",
            )
            const bestMatch = visible.reduce<(typeof navItems)[number] | null>(
              (best, item) => {
                const match =
                  pathname === item.href || pathname.startsWith(`${item.href}/`)
                if (!match) return best
                if (!best) return item
                return item.href.length > best.href.length ? item : best
              },
              null,
            )
            return visible.map((item) => {
              const isActive = bestMatch === item
              const Icon = item.icon
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
            })
          })()}
        </nav>

        <div className="border-t pt-6">
          <div className="flex items-center gap-2">
            <div className="min-w-0 flex-1">
              <OrgSwitcher />
            </div>
            <Notifications />
          </div>
          <div className="mt-3 flex items-center gap-2">
            <span className="text-sm font-medium">{u.name ?? u.email}</span>
            <button
              type="button"
              onClick={signOut}
              className="ml-auto flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
            >
              <LogOut className="h-3 w-3" />
              Sign out
            </button>
          </div>
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
          <div className="ml-auto">
            <Notifications />
          </div>
        </header>

        {/* Phase 7.10 — Banner short-circuits to null for verified/non-CUSTOMER users. */}
        <EmailVerificationBannerContainer />
        <main className="flex-1 p-6 lg:p-8">{children}</main>
      </div>
    </div>
  )
}
