import {
  IntegrationSyncStatus,
  type Pagination,
  type SyncJob,
} from "@guestpost/integrations/client"
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

type SyncHistoryRow = Partial<SyncJob>

interface SyncHistoryTableProps {
  rows?: SyncHistoryRow[]
  syncs?: SyncHistoryRow[]
  loading?: boolean
  emptyState?: ReactNode
  pagination?: Pagination
  onPageChange?: (page: number) => void
  className?: string
}

function SyncHistoryTable({
  rows,
  syncs,
  loading = false,
  emptyState,
  pagination,
  onPageChange,
  className,
}: SyncHistoryTableProps) {
  const items = rows ?? syncs ?? []
  const currentPage = pagination?.page ?? 1
  const pageSize = pagination?.pageSize ?? items.length
  const total = pagination?.total ?? items.length
  const pageCount = Math.max(1, Math.ceil(total / Math.max(1, pageSize)))

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

  if (items.length === 0) {
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
            {items.map((sync, index) => {
              const startedAt = sync.startedAt ? new Date(sync.startedAt) : null
              const trigger = sync.trigger ?? "manual"
              const progress = sync.progress ?? { completed: 0, total: 0 }
              return (
                <TableRow key={sync.id ?? index}>
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
                      status={sync.status ?? IntegrationSyncStatus.PENDING}
                    />
                  </TableCell>
                  <TableCell className="text-sm">
                    {sync.recordsProcessed ?? 0}
                  </TableCell>
                  <TableCell className="max-w-[200px] text-sm text-destructive">
                    {sync.errorMessage && (
                      <span
                        className="block truncate"
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

      {pagination && onPageChange ? (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {total} sync{total !== 1 ? "s" : ""}
          </p>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="icon"
              onClick={() => onPageChange(currentPage - 1)}
              disabled={currentPage <= 1}
              aria-label="Previous page"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </Button>
            <span className="px-2 text-sm">
              Page {currentPage} of {pageCount}
            </span>
            <Button
              variant="outline"
              size="icon"
              onClick={() => onPageChange(currentPage + 1)}
              disabled={!pagination.hasNext}
              aria-label="Next page"
            >
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export type { SyncHistoryTableProps }
export { SyncHistoryTable }
