import type { LinkedWebsite } from "@guestpost/integrations"
import { Globe, Trash2 } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "../../../lib/utils"
import { Button } from "../../button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../table"
import { IntegrationStatusBadge } from "../primitives/integration-status-badge"

interface WebsiteIntegrationListProps {
  websites: LinkedWebsite[]
  onUnlink: (websiteIntegrationId: string) => void
  renderActions?: (website: LinkedWebsite) => ReactNode
  className?: string
}

function WebsiteIntegrationList({
  websites,
  onUnlink,
  renderActions,
  className,
}: WebsiteIntegrationListProps) {
  if (websites.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-3 py-8 text-center",
          className,
        )}
      >
        <Globe className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">No linked websites.</p>
      </div>
    )
  }

  return (
    <div className={cn("rounded-lg border", className)}>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Property URL</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Synced</TableHead>
            <TableHead className="w-24">
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {websites.map((w) => (
            <TableRow key={w.id}>
              <TableCell className="font-medium">{w.propertyUrl}</TableCell>
              <TableCell>
                {w.status === "SYNCING" ? (
                  <span className="text-blue-500">Syncing</span>
                ) : (
                  <IntegrationStatusBadge status={w.status as any} />
                )}
              </TableCell>
              <TableCell className="text-muted-foreground">
                {w.syncedAt
                  ? new Date(w.syncedAt).toLocaleDateString()
                  : "Never"}
              </TableCell>
              <TableCell>
                <div className="flex items-center gap-1">
                  {renderActions?.(w)}
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => onUnlink(w.id!)}
                    aria-label={`Unlink ${w.propertyUrl}`}
                  >
                    <Trash2 className="h-4 w-4" aria-hidden="true" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

export type { WebsiteIntegrationListProps }
export { WebsiteIntegrationList }
