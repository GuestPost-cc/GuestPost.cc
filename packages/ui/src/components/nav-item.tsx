"use client"

import { type LucideIcon } from "lucide-react"
import { forwardRef } from "react"
import { cn } from "../lib/utils"

interface NavItemProps extends React.AnchorHTMLAttributes<HTMLAnchorElement> {
  icon: LucideIcon
  isActive?: boolean
}

const NavItem = forwardRef<HTMLAnchorElement, NavItemProps>(
  ({ icon: Icon, isActive, className, children, ...props }, ref) => {
    return (
      <a
        ref={ref}
        className={cn(
          "flex items-center gap-3 rounded-md px-3 py-2 text-sm font-medium transition-all duration-200",
          isActive
            ? "bg-primary/10 text-primary"
            : "text-muted-foreground hover:bg-surface-1 hover:text-foreground",
          className,
        )}
        {...props}
      >
        <Icon className="h-4 w-4 shrink-0" />
        {children}
      </a>
    )
  },
)
NavItem.displayName = "NavItem"

export type { NavItemProps }
export { NavItem }
