"use client"

import { cn, Drawer, DrawerContent, DrawerTitle } from "@guestpost/ui"
import type { LucideIcon } from "lucide-react"
import {
  AlertTriangle,
  Building,
  ClipboardCheck,
  ClipboardList,
  Globe2,
  HeadphonesIcon,
  Landmark,
  LayoutDashboard,
  LogOut,
  Menu,
  Newspaper,
  Scale,
  ScrollText,
  Settings,
  ShieldCheck,
  ShoppingCart,
  Store,
  Users,
  X,
} from "lucide-react"
import Link from "next/link"
import { usePathname, useRouter } from "next/navigation"
import { useEffect, useState } from "react"
import { Notifications } from "../../components/notifications"
import { useAuth } from "../../lib/auth"

type StaffRole = "SUPER_ADMIN" | "OPERATIONS" | "FINANCE"

interface NavItem {
  href: string
  label: string
  icon: LucideIcon
  roles?: StaffRole[]
}

interface NavGroup {
  label: string
  items: NavItem[]
}

const navGroups: NavGroup[] = [
  {
    label: "Command",
    items: [
      {
        href: "/dashboard",
        label: "Overview",
        icon: LayoutDashboard,
      },
      { href: "/dashboard/orders", label: "Orders", icon: ShoppingCart },
      {
        href: "/dashboard/fulfillment",
        label: "Fulfillment",
        icon: ClipboardList,
        roles: ["SUPER_ADMIN", "OPERATIONS"],
      },
    ],
  },
  {
    label: "Resolution",
    items: [
      {
        href: "/dashboard/disputes",
        label: "Disputes",
        icon: AlertTriangle,
      },
      {
        href: "/dashboard/cancellations",
        label: "Cancellations",
        icon: Scale,
      },
      {
        href: "/dashboard/support",
        label: "Support",
        icon: HeadphonesIcon,
      },
      {
        href: "/dashboard/verification/delivery",
        label: "Delivery Verification",
        icon: ClipboardCheck,
        roles: ["SUPER_ADMIN", "OPERATIONS"],
      },
      {
        href: "/dashboard/verification",
        label: "Domain Verification",
        icon: ShieldCheck,
        roles: ["SUPER_ADMIN", "OPERATIONS"],
      },
    ],
  },
  {
    label: "Inventory",
    items: [
      {
        href: "/dashboard/marketplace",
        label: "Marketplace",
        icon: Store,
        roles: ["SUPER_ADMIN", "OPERATIONS"],
      },
      {
        href: "/dashboard/websites",
        label: "Platform Websites",
        icon: Globe2,
        roles: ["SUPER_ADMIN", "OPERATIONS"],
      },
    ],
  },
  {
    label: "People",
    items: [
      {
        href: "/dashboard/users",
        label: "Users & Staff",
        icon: Users,
        roles: ["SUPER_ADMIN"],
      },
      {
        href: "/dashboard/publishers",
        label: "Publishers",
        icon: Newspaper,
        roles: ["SUPER_ADMIN", "FINANCE"],
      },
      {
        href: "/dashboard/organizations",
        label: "Organizations",
        icon: Building,
        roles: ["SUPER_ADMIN"],
      },
    ],
  },
  {
    label: "Finance",
    items: [
      {
        href: "/dashboard/finance",
        label: "Finance Center",
        icon: Landmark,
        roles: ["SUPER_ADMIN", "FINANCE"],
      },
      {
        href: "/dashboard/finance/settlement-review",
        label: "Evidence Review",
        icon: Scale,
        roles: ["SUPER_ADMIN", "FINANCE"],
      },
    ],
  },
  {
    label: "Governance",
    items: [
      {
        href: "/dashboard/audit-logs",
        label: "Audit Logs",
        icon: ScrollText,
        roles: ["SUPER_ADMIN"],
      },
      { href: "/dashboard/settings", label: "Settings", icon: Settings },
    ],
  },
]

const pageNames: Record<string, string> = {
  "/dashboard": "Overview",
  "/dashboard/orders": "Orders",
  "/dashboard/fulfillment": "Fulfillment",
  "/dashboard/disputes": "Disputes",
  "/dashboard/cancellations": "Cancellations",
  "/dashboard/support": "Support",
  "/dashboard/verification/delivery": "Delivery Verification",
  "/dashboard/verification": "Domain Verification",
  "/dashboard/marketplace": "Marketplace",
  "/dashboard/websites": "Platform Websites",
  "/dashboard/users": "Users & Staff",
  "/dashboard/publishers": "Publishers",
  "/dashboard/organizations": "Organizations",
  "/dashboard/finance/settlement-review": "Settlement Evidence Review",
  "/dashboard/finance": "Finance Center",
  "/dashboard/audit-logs": "Audit Logs",
  "/dashboard/settings": "Settings",
}

const roleLabels: Record<StaffRole, string> = {
  SUPER_ADMIN: "Super Admin",
  OPERATIONS: "Operations",
  FINANCE: "Finance",
}

const workspaceBrandLabels: Record<StaffRole, string> = {
  SUPER_ADMIN: "Administration",
  OPERATIONS: "Operations",
  FINANCE: "Finance",
}

function pageName(pathname: string, role: StaffRole) {
  if (pathname === "/dashboard") {
    if (role === "SUPER_ADMIN") return "Command Center"
    if (role === "OPERATIONS") return "Operations Workbench"
    return "Finance Workbench"
  }

  const bestMatch = Object.keys(pageNames)
    .filter(
      (path) =>
        pathname === path ||
        (path !== "/dashboard" && pathname.startsWith(`${path}/`)),
    )
    .sort((left, right) => right.length - left.length)[0]
  return pageNames[bestMatch] ?? "Admin Workspace"
}

function itemLabel(item: NavItem, role: StaffRole) {
  if (item.href === "/dashboard") {
    if (role === "SUPER_ADMIN") return "Command Center"
    if (role === "OPERATIONS") return "Operations Workbench"
    return "Finance Workbench"
  }
  if (item.href === "/dashboard/fulfillment" && role === "OPERATIONS") {
    return "My Fulfillment"
  }
  if (item.href === "/dashboard/orders" && role === "OPERATIONS") {
    return "Order Monitor"
  }
  return item.label
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

  useEffect(() => {
    if (!loading && !user) router.replace("/")
  }, [user, loading, router])

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigation closes the mobile drawer
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20">
        <div className="flex flex-col items-center gap-3">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm text-muted-foreground">Loading workspace…</p>
        </div>
      </div>
    )
  }
  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-muted/20 px-6">
        <div className="flex flex-col items-center gap-3 text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
          <p className="text-sm font-medium">Returning to secure login…</p>
          <p className="text-xs text-muted-foreground">
            Your administrator session is unavailable or has expired.
          </p>
        </div>
      </div>
    )
  }

  const staff = user
  const role = staff.staffRole as StaffRole
  const initial = (staff.name ?? staff.email).charAt(0).toUpperCase()
  const visibleItems = navGroups.flatMap((group) =>
    group.items.filter((item) => !item.roles || item.roles.includes(role)),
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
              <ShieldCheck className="h-5 w-5" />
            </div>
            <div>
              <span className="block leading-5">GuestPost</span>
              <span className="block text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                {workspaceBrandLabels[role]}
              </span>
            </div>
          </Link>
          {inDrawer ? (
            <button
              type="button"
              onClick={() => setMobileOpen(false)}
              aria-label="Close menu"
              className="rounded-lg p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          ) : null}
        </div>

        <nav
          className="flex-1 space-y-6 overflow-y-auto"
          aria-label="Staff navigation"
        >
          {navGroups.map((group) => {
            const visibleGroupItems = group.items.filter(
              (item) => !item.roles || item.roles.includes(role),
            )
            let items = visibleGroupItems
            if (
              (role === "FINANCE" || role === "OPERATIONS") &&
              group.label === "Resolution"
            ) {
              items = [...items].sort((left, right) => {
                if (left.href === "/dashboard/support") return -1
                if (right.href === "/dashboard/support") return 1
                return 0
              })
            }
            if (role === "OPERATIONS" && group.label === "Command") {
              const commandRank: Record<string, number> = {
                "/dashboard": 0,
                "/dashboard/fulfillment": 1,
                "/dashboard/orders": 2,
              }
              items = [...items].sort(
                (left, right) =>
                  (commandRank[left.href] ?? 99) -
                  (commandRank[right.href] ?? 99),
              )
            }
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
                        {itemLabel(item, role)}
                      </Link>
                    )
                  })}
                </div>
              </div>
            )
          })}
        </nav>

        <div className="mt-5 rounded-2xl border bg-background p-3 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary">
              {initial}
            </div>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold">
                {staff.name ?? staff.email}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {roleLabels[role] ?? "Staff"}
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
          <DrawerTitle className="sr-only">Staff navigation</DrawerTitle>
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
                {pageName(pathname, role)}
              </p>
              <p className="hidden text-xs text-muted-foreground sm:block">
                {roleLabels[role] ?? "Staff"} workspace
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
