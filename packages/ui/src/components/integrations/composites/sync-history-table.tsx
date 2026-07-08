import type { SyncJob } from "@guestpost/integrations"
import { ChevronLeft, ChevronRight } from "lucide-react"
import type { ReactNode } from "react"
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
import { SyncProgress } from "../primitives/sync-progress"

interface SyncHistoryTableProps {
  rows: SyncJob[]
  loading?: boolean
  emptyState?: ReactNode
  pagination: {
    page: number
    pageSize: number
    total: number
    hasNext: boolean
  }
  onPageChange: (page: number) => void
  className?: string
}

function SyncHistoryTable({
  rows,
  loading = false,
  emptyState,
  pagination,
  onPageChange,
  className,
}: SyncHistoryTableProps) {
  const pageCount = Math.ceil(pagination.total / pagination.pageSize)

  if (loading) {
    return (
      <div
        className={cn("space-y-2", className)}
        role="region"
        aria-label="Loading sync history"
      >
        {Array.from({ length: 3 }).map((_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    )
  }

  if (rows.length === 0) {
    return (
      <div className={cn(className)}>
        {emptyState ?? (
          <p className="py-8 text-center text-sm text-muted-foreground">
            No sync history.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className={cn("space-y-4", className)}>
      <div className="rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Trigger</TableHead>
              <TableHead>Progress</TableHead>
              <TableHead>Records</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((sync) => {
              const startedAt = sync.startedAt ? new Date(sync.startedAt) : null
              const trigger = sync.trigger ?? "manual"
              const progress = sync.progress ?? { completed: 0, total: 0 }
              return (
                <TableRow key={sync.id}>
                  <TableCell className="text-sm">
                    {startedAt?.toLocaleDateString() ?? "—"}
                    <br />
                    {startedAt && (
                      <span className="text-xs text-muted-foreground">
                        {startedAt.toLocaleTimeString()}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="capitalize">
                    {trigger.toLowerCase()}
                  </TableCell>
                  <TableCell className="min-w-[180px]">
                    <SyncProgress
                      completed={progress.completed ?? 0}
                      total={progress.total ?? 0}
                      status={sync.status!}
                    />
                  </TableCell>
                  <TableCell className="text-sm">
                    {sync.recordsProcessed ?? 0}
                  </TableCell>
                  <TableCell className="max-w-[200px] text-sm text-destructive">
                    {sync.errorMessage && (
                      <span
                        className="truncate block"
                        title={sync.errorMessage}
                      >
                        {sync.errorMessage}
                      </span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {pagination.total} sync{pagination.total !== 1 ? "s" : ""}
        </p>
        <div className="flex items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            onClick={() => onPageChange(pagination.page - 1)}
            disabled={pagination.page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" aria-hidden="true" />
          </Button>
          <span className="px-2 text-sm">
            Page {pagination.page} of {pageCount || 1}
          </span>
          <Button
            variant="outline"
            size="icon"
            onClick={() => onPageChange(pagination.page + 1)}
            disabled={!pagination.hasNext}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" aria-hidden="true" />
          </Button>
        </div>
      </div>
    </div>
  )
}

export type { SyncHistoryTableProps }
export { SyncHistoryTable }
