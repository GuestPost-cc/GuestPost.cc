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
  { href: "/dashboard/users", label: "Users", icon: Users },
  { href: "/dashboard/publishers", label: "Publishers", icon: Newspaper },
  { href: "/dashboard/organizations", label: "Organizations", icon: Building },
  { href: "/dashboard/orders", label: "Orders", icon: ShoppingCart },
  {
    href: "/dashboard/disputes",
    label: "Disputes",
    icon: AlertTriangle,
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
    href: "/dashboard/fulfillment",
    label: "Fulfillment",
    icon: ClipboardList,
    roles: ["SUPER_ADMIN", "OPERATIONS"],
  },
  {
    href: "/dashboard/verification",
    label: "Verification",
    icon: ShieldCheck,
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
    if (!loading && !user) router.push("/")
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
  if (!user) return null
  // Local non-null alias so the nested SidebarContents closure has a
  // narrowed type without each ref needing a `!` non-null assertion.
  const u = user

  // Same nav body for desktop sidebar + mobile drawer. Extracting it
  // local-to-this-file rather than promoting to @guestpost/ui — the
  // staff-role allowlist + sign-out handler are this layout's concerns.
  function SidebarContents({ inDrawer = false }: { inDrawer?: boolean }) {
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
          {navItems
            .filter(
              (item) =>
                !item.roles ||
                (u.staffRole && item.roles.includes(u.staffRole as StaffRole)),
            )
            .map((item) => {
              const Icon = item.icon
              const isActive = pathname === item.href
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
              {ROLE_LABELS[u.staffRole as StaffRole] ?? "Staff"}
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
        <main className="flex-1 p-8">{children}</main>
      </div>
    </div>
  )
}
