"use client"

import { cn } from "@guestpost/ui"
import { Building2, Group, Users } from "lucide-react"
import Link from "next/link"
import { usePathname } from "next/navigation"

const subNav = [
  {
    href: "/dashboard/settings/organization",
    label: "Overview",
    icon: Building2,
  },
  {
    href: "/dashboard/settings/organization/members",
    label: "Members",
    icon: Users,
  },
  {
    href: "/dashboard/settings/organization/teams",
    label: "Teams",
    icon: Group,
  },
]

export default function OrgSettingsLayout({
  children,
}: {
  children: React.ReactNode
}) {
  const pathname = usePathname()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Organization</h1>
        <p className="text-muted-foreground">
          Manage your organization, members, and teams
        </p>
      </div>

      <nav className="flex gap-1 border-b">
        {subNav.map((item) => {
          const isActive = pathname === item.href
          const Icon = item.icon
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors",
                isActive
                  ? "border-primary text-primary"
                  : "border-transparent text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="h-4 w-4" />
              {item.label}
            </Link>
          )
        })}
      </nav>

      {children}
    </div>
  )
}
