"use client"

import { cn, Drawer, DrawerContent, DrawerTitle } from "@guestpost/ui"
import {
  CircleDollarSign,
  CreditCard,
  Globe2,
  LayoutDashboard,
  LifeBuoy,
  LogOut,
  Menu,
  Plug,
  Settings,
  ShoppingBag,
  Store,
  WalletCards,
  X,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useRef, useState } from "react"
import { Notifications } from "../../components/notifications"
import { useAuth } from "../../lib/auth"

const navGroups = [
  {
    label: "Work",
    items: [
      { href: "/dashboard", label: "Work Queue", icon: LayoutDashboard },
      { href: "/dashboard/orders", label: "Orders", icon: ShoppingBag },
    ],
  },
  {
    label: "Inventory",
    items: [
      { href: "/dashboard/websites", label: "Websites", icon: Globe2 },
      { href: "/dashboard/listings", label: "Listings", icon: Store },
    ],
  },
  {
    label: "Finance",
    items: [
      {
        href: "/dashboard/earnings",
        label: "Earnings",
        icon: CircleDollarSign,
      },
      {
        href: "/dashboard/withdrawals",
        label: "Withdrawals",
        icon: WalletCards,
      },
      {
        href: "/dashboard/payout-methods",
        label: "Payout Methods",
        icon: CreditCard,
      },
    ],
  },
  {
    label: "Account",
    items: [
      { href: "/dashboard/integrations", label: "Integrations", icon: Plug },
      { href: "/dashboard/support", label: "Support", icon: LifeBuoy },
      { href: "/dashboard/settings", label: "Settings", icon: Settings },
    ],
  },
]

const pageNames: Record<string, string> = {
  "/dashboard": "Work Queue",
  "/dashboard/orders": "Orders",
  "/dashboard/websites": "Websites",
  "/dashboard/listings": "Listings",
  "/dashboard/earnings": "Earnings",
  "/dashboard/withdrawals": "Withdrawals",
  "/dashboard/payout-methods": "Payout Methods",
  "/dashboard/integrations": "Integrations",
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
    .sort((a, b) => b.length - a.length)[0]
  return pageNames[bestMatch] ?? "Publisher Workspace"
}

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
  if (!user) return null

  const publisher = user
  const initial = (publisher.name ?? publisher.email).charAt(0).toUpperCase()

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
          aria-label="Publisher navigation"
        >
          {navGroups.map((group) => (
            <div key={group.label}>
              <p className="mb-2 px-3 text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.map((item) => {
                  const Icon = item.icon
                  const isActive =
                    pathname === item.href ||
                    (item.href !== "/dashboard" &&
                      pathname.startsWith(`${item.href}/`))
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
          ))}
        </nav>

        <div className="mt-5 rounded-2xl border bg-background p-3 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {publisher.name ?? "Publisher"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {publisher.email}
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
    )
  }

  return (
    <div className="min-h-screen bg-muted/20">
      <aside className="fixed inset-y-0 left-0 z-50 hidden w-64 border-r bg-background lg:block">
        <SidebarContents />
      </aside>

      <Drawer open={mobileOpen} onOpenChange={setMobileOpen}>
        <DrawerContent side="left" className="bg-background">
          <DrawerTitle className="sr-only">Publisher navigation</DrawerTitle>
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
                Publisher workspace
              </p>
            </div>
            <Notifications />
          </div>
        </header>

        <main className="min-h-[calc(100vh-4rem)]">
          <div className="mx-auto w-full max-w-[1500px] p-4 sm:p-6 lg:p-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  )
}
