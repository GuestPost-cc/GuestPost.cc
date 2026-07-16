"use client"

import { cn, Drawer, DrawerContent, DrawerTitle } from "@guestpost/ui"
import {
  AlertTriangle,
  Building,
  ClipboardList,
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

// Per-item role allowlist mirroring the backend @StaffRoles guards: finance
// surfaces (settlements/withdrawals/payouts/reconciliation) are FINANCE +
// SUPER_ADMIN; the old boolean `adminOnly` flag locked FINANCE staff out of
// pages the API authorizes them to use.
type StaffRole = "SUPER_ADMIN" | "OPERATIONS" | "FINANCE"

const navItems: Array<{
  href: string
  label: string
  icon: any
  roles?: StaffRole[]
}> = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  {
    href: "/dashboard/fulfillment",
    label: "Fulfillment",
    icon: ClipboardList,
    roles: ["SUPER_ADMIN", "OPERATIONS"],
  },
  {
    href: "/dashboard/users",
    label: "Users",
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
  { href: "/dashboard/orders", label: "Orders", icon: ShoppingCart },
  {
    href: "/dashboard/disputes",
    label: "Disputes",
    icon: AlertTriangle,
    roles: ["SUPER_ADMIN", "OPERATIONS", "FINANCE"],
  },
  {
    href: "/dashboard/cancellations",
    label: "Cancellations",
    icon: Scale,
    roles: ["SUPER_ADMIN", "OPERATIONS", "FINANCE"],
  },
  {
    href: "/dashboard/marketplace",
    label: "Marketplace",
    icon: Store,
    roles: ["SUPER_ADMIN", "OPERATIONS"],
  },
  {
    href: "/dashboard/websites",
    label: "Platform Websites",
    icon: Store,
    roles: ["SUPER_ADMIN", "OPERATIONS"],
  },
  {
    href: "/dashboard/verification",
    label: "Domain Verification",
    icon: ShieldCheck,
    roles: ["SUPER_ADMIN", "OPERATIONS"],
  },
  {
    href: "/dashboard/verification/delivery",
    label: "Delivery Verification",
    icon: ClipboardList,
    roles: ["SUPER_ADMIN", "OPERATIONS"],
  },
  {
    href: "/dashboard/finance",
    label: "Finance",
    icon: Landmark,
    roles: ["SUPER_ADMIN", "FINANCE"],
  },
  {
    href: "/dashboard/finance/settlement-review",
    label: "Settlement Review",
    icon: Scale,
    roles: ["SUPER_ADMIN", "FINANCE"],
  },
  { href: "/dashboard/support", label: "Support", icon: HeadphonesIcon },
  {
    href: "/dashboard/audit-logs",
    label: "Audit Logs",
    icon: ScrollText,
    roles: ["SUPER_ADMIN"],
  },
  { href: "/dashboard/settings", label: "Settings", icon: Settings },
]

const ROLE_LABELS: Record<StaffRole, string> = {
  SUPER_ADMIN: "Super Admin",
  OPERATIONS: "Operations",
  FINANCE: "Finance",
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

  // Pathname-auto-close — closes mobile drawer on navigation
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run on pathname change to close drawer
  useEffect(() => {
    setMobileOpen(false)
  }, [pathname])

  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center">
        Loading...
      </div>
    )
  if (!user)
    return (
      <div className="flex min-h-screen items-center justify-center text-sm text-muted-foreground">
        Returning to sign in...
      </div>
    )
  // Local non-null alias so the nested SidebarContents closure has a
  // narrowed type without each ref needing a `!` non-null assertion.
  const u = user

  // Same nav body for desktop sidebar + mobile drawer. Extracting it
  // local-to-this-file rather than promoting to @guestpost/ui — the
  // staff-role allowlist + sign-out handler are this layout's concerns.
  function SidebarContents({ inDrawer = false }: { inDrawer?: boolean }) {
    const visibleNavItems = navItems.filter(
      (item) =>
        !item.roles ||
        (u.staffRole && item.roles.includes(u.staffRole as StaffRole)),
    )
    const activeHref = visibleNavItems
      .filter(
        (item) =>
          pathname === item.href ||
          (item.href !== "/dashboard" && pathname.startsWith(`${item.href}/`)),
      )
      .sort((left, right) => right.href.length - left.href.length)[0]?.href

    return (
      <div className="flex h-full flex-col p-6">
        <div className="mb-8 flex items-center justify-between">
          <Link href="/dashboard" className="text-lg font-bold tracking-tight">
            GuestPost Admin
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
          {visibleNavItems.map((item) => {
            const Icon = item.icon
            const isActive = activeHref === item.href
            const label =
              item.href === "/dashboard/fulfillment" &&
              u.staffRole === "OPERATIONS"
                ? "My Fulfillment"
                : item.label
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
                {label}
              </Link>
            )
          })}
        </nav>
        <div className="border-t pt-6">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <div
                className="truncate text-sm font-medium"
                title={u.name ?? u.email}
              >
                {u.name ?? u.email}
              </div>
              <span className="mt-1 inline-flex items-center rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-primary">
                {ROLE_LABELS[u.staffRole as StaffRole] ?? "Staff"}
              </span>
            </div>
            <span className="shrink-0">
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

      {/* Mobile drawer — Phase 7.6.1 a11y: escape close, focus trap,
          scroll-lock, ARIA dialog semantics all from Radix Dialog. */}
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
            GuestPost Admin
          </Link>
        </header>
        <main className="flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  )
}
