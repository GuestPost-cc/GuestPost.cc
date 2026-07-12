import type { DiscoveredResource } from "@guestpost/integrations/client"
import { Globe, RefreshCw } from "lucide-react"
import { cn } from "../../../lib/utils"
import { Button } from "../../button"
import { Skeleton } from "../../skeleton"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../../table"

interface ResourceTableProps {
  resources: DiscoveredResource[]
  selectedResource?: string
  onSelect: (externalResourceId: string) => void
  onRefresh: () => void
  loading?: boolean
  className?: string
}

function ResourceTable({
  resources,
  selectedResource,
  onSelect,
  onRefresh,
  loading = false,
  className,
}: ResourceTableProps) {
  if (loading) {
    return (
      <div
        className={cn("space-y-2", className)}
        role="region"
        aria-label="Loading resources"
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (resources.length === 0) {
    return (
      <div
        className={cn(
          "flex flex-col items-center gap-3 py-8 text-center",
          className,
        )}
      >
        <Globe className="h-8 w-8 text-muted-foreground" aria-hidden="true" />
        <p className="text-sm text-muted-foreground">
          No resources discovered yet.
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          className="gap-1.5"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Discover resources
        </Button>
      </div>
    )
  }

  return (
    <div className={cn(className)}>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {resources.length} resource{resources.length !== 1 ? "s" : ""} found
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          className="gap-1.5"
        >
          <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
          Refresh
        </Button>
      </div>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10">
                <span className="sr-only">Select</span>
              </TableHead>
              <TableHead>Property URL</TableHead>
              <TableHead>Permission</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {resources.map((r) => {
              const isSelected = r.externalResourceId === selectedResource
              return (
                <TableRow
                  key={r.externalResourceId}
                  className={cn("cursor-pointer", isSelected && "bg-muted/50")}
                  onClick={() => onSelect(r.externalResourceId)}
                  aria-selected={isSelected}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault()
                      onSelect(r.externalResourceId)
                    }
                  }}
                >
                  <TableCell>
                    <div
                      className={cn(
                        "h-4 w-4 rounded border",
                        isSelected
                          ? "border-primary bg-primary"
                          : "border-border",
                      )}
                      aria-hidden="true"
                    />
                  </TableCell>
                  <TableCell className="font-medium">
                    <a
                      href={r.externalResourceName ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:underline"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {r.externalResourceName ?? r.externalResourceId}
                    </a>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {(r.metadata as any)?.permissionLevel ?? "\u2014"}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}

export type { ResourceTableProps }
export { ResourceTable }
