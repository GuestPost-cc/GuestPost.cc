"use client"

import { Badge } from "@guestpost/ui"

const roleConfig: Record<string, { variant: "default" | "secondary" | "destructive" | "outline" | "success" | "warning" | "info"; label: string }> = {
  OWNER: { variant: "default", label: "Owner" },
  ADMIN: { variant: "warning", label: "Admin" },
  MANAGER: { variant: "info", label: "Manager" },
  MEMBER: { variant: "secondary", label: "Member" },
  VIEWER: { variant: "outline", label: "Viewer" },
}

export function RoleBadge({ role }: { role: string }) {
  const config = roleConfig[role] ?? { variant: "outline" as const, label: role }
  return <Badge variant={config.variant}>{config.label}</Badge>
}
