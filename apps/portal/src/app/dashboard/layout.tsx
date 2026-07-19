"use client"

import { cn, Drawer, DrawerContent, DrawerTitle } from "@guestpost/ui"
import {
  BarChart3,
  Bookmark,
  Building2,
  CreditCard,
  Globe2,
  Heart,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Megaphone,
  Menu,
  Settings,
  ShoppingBag,
  Store,
  X,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { CreateOrgGate } from "../../components/create-org-gate"
import { EmailVerificationBannerContainer } from "../../components/email-verification-banner-container"
import { Notifications } from "../../components/notifications"
import { OrgSwitcher } from "../../components/org-switcher"
import { useAuth } from "../../lib/auth"

const navGroups = [
  {
    label: "Work",
    items: [
      { href: "/dashboard", label: "Work Queue", icon: LayoutDashboard },
      { href: "/dashboard/orders", label: "Orders", icon: ShoppingBag },
      { href: "/dashboard/campaigns", label: "Campaigns", icon: Megaphone },
    ],
  },
  {
    label: "Discover",
    items: [
      { href: "/dashboard/marketplace", label: "Marketplace", icon: Store },
      {
        href: "/dashboard/marketplace/favorites",
        label: "Favorites",
        icon: Heart,
      },
      {
        href: "/dashboard/marketplace/saved-lists",
        label: "Saved Lists",
        icon: Bookmark,
      },
    ],
  },
  {
    label: "Results & Finance",
    items: [
      { href: "/dashboard/reports", label: "Reports", icon: BarChart3 },
      {
        href: "/dashboard/billing",
        label: "Billing",
        icon: CreditCard,
        ownerOnly: true,
      },
    ],
  },
  {
    label: "Account",
    items: [
      {
        href: "/dashboard/settings/organization",
        label: "Organization",
        icon: Building2,
      },
      { href: "/dashboard/support", label: "Support", icon: LifeBuoy },
      { href: "/dashboard/settings", label: "Settings", icon: Settings },
    ],
  },
] as const

const pageNames: Record<string, string> = {
  "/dashboard": "Work Queue",
  "/dashboard/orders": "Orders",
  "/dashboard/campaigns": "Campaigns",
  "/dashboard/marketplace": "Marketplace",
  "/dashboard/marketplace/favorites": "Favorites",
  "/dashboard/marketplace/saved-lists": "Saved Lists",
  "/dashboard/reports": "Reports",
  "/dashboard/billing": "Billing",
  "/dashboard/settings/organization": "Organization",
  "/dashboard/support": "Support",
  "/dashboard/settings": "Settings",
}

function pageName(pathname: string) {
  const bestMatch = Object.keys(pageNames)
    .filter(
      (path) =>
        pathname === path ||
        (path !== "/dashboard" && pathname.startsWith(`${path}/`)),
    )
    .sort((left, right) => right.length - left.length)[0]
  return pageNames[bestMatch] ?? "Customer Workspace"
}

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const { user, loading, signOut, refresh } = useAuth()
  const router = useRouter()
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)

  useEffect(() => {
    if (!loading && !user) {
      router.replace(`/?returnTo=${encodeURIComponent(pathname)}`)
    }
  }, [user, loading, router, pathname])

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation closes the mobile drawer
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading workspace…</p>
        </div>
      </div>
    )
  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20 text-sm text-muted-foreground">
        Redirecting to secure login…
      </div>
    )
  }

  if (!user.organizationId) {
    return <CreateOrgGate onCreated={() => refresh()} />
  }

  const customer = user
  const initial = (customer.name ?? customer.email).charAt(0).toUpperCase()
  const visibleItems = navGroups.flatMap((group) =>
    group.items.filter(
      (item) =>
        !("ownerOnly" in item && item.ownerOnly) ||
        customer.customerRole === "OWNER",
    ),
  )
  const bestNavMatch = visibleItems
    .filter(
      (item) =>
        pathname === item.href ||
        (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`)),
    )
    .sort((left, right) => right.href.length - left.href.length)[0]

  function SidebarContents({ inDrawer = false }: { inDrawer?: boolean }) {
    return (
      <div className="flex h-full flex-col px-4 py-5">
        <div className="mb-7 flex items-center justify-between px-2">
          <Link
            href="/dashboard"
            className="flex items-center gap-2.5 text-lg font-bold tracking-tight"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-primary text-primary-foreground shadow-sm">
              <Globe2 className="h-5 w-5" />
            </div>
            <span>GuestPost</span>
          </Link>
          {inDrawer && (
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
              className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          )}
        </div>

        <nav
          className="flex-1 space-y-6 overflow-y-auto"
          aria-label="Customer navigation"
        >
          {navGroups.map((group) => {
            const items = group.items.filter(
              (item) =>
                !("ownerOnly" in item && item.ownerOnly) ||
                customer.customerRole === "OWNER",
            )
            if (!items.length) return null
            return (
              <div key={group.label}>
                <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                  {group.label}
                </p>
                <div className="space-y-1">
                  {items.map((item) => {
                    const Icon = item.icon
                    const isActive = bestNavMatch?.href === item.href
                    return (
                      <Link
                        key={item.href}
                        href={item.href}
                        aria-current={isActive ? "page" : undefined}
                        className={cn(
                          "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors",
                          isActive
                            ? "bg-foreground text-background shadow-sm"
                            : "text-muted-foreground hover:bg-muted hover:text-foreground",
                        )}
                      >
                        <Icon className="h-4 w-4 shrink-0" />
                        {item.label}
                      </Link>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </nav>

        <div className="mt-5 space-y-3">
          <div className="rounded-xl border bg-background p-2 shadow-sm">
            <OrgSwitcher />
          </div>
          <div className="rounded-2xl border bg-background p-3 shadow-sm">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
                {initial}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-semibold">
                  {customer.name ?? "Customer"}
                </p>
                <p className="truncate text-xs capitalize text-muted-foreground">
                  {customer.customerRole?.toLowerCase() ?? "member"}
                </p>
              </div>
              <button
                type="button"
                onClick={signOut}
                aria-label="Sign out"
                className="rounded-lg p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <LogOut className="h-4 w-4" />
              </button>
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <aside className="fixed inset-y-0 left-0 z-50 hidden w-64 border-r bg-background lg:block">
        <SidebarContents />
      </aside>

      <Drawer open={mobileOpen} onOpenChange={setMobileOpen}>
        <DrawerContent side="left" className="bg-background">
          <DrawerTitle className="sr-only">Customer navigation</DrawerTitle>
          <SidebarContents inDrawer />
        </DrawerContent>
      </Drawer>

      <div className="min-w-0 lg:pl-64">
        <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
          <div className="flex h-16 items-center gap-4 px-4 sm:px-6 lg:px-8">
            <button
              type="button"
              onClick={() => setMobileOpen(true)}
              aria-label="Open menu"
              className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground lg:hidden"
            >
              <Menu className="h-5 w-5" />
            </button>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {pageName(pathname)}
              </p>
              <p className="hidden text-xs text-muted-foreground sm:block">
                Customer workspace
              </p>
            </div>
            <Notifications />
          </div>
        </header>

        <EmailVerificationBannerContainer />
        <main className="min-h-[calc(100vh-4rem)]">
          <div className="mx-auto w-full max-w-[1500px] p-4 sm:p-6 lg:p-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
