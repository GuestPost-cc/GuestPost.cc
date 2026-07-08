import { IntegrationSyncStatus } from "@guestpost/integrations"
import { cn } from "../../../lib/utils"

interface SyncProgressProps {
  completed: number
  total: number
  status: IntegrationSyncStatus
  className?: string
}

function SyncProgress({
  completed,
  total,
  status,
  className,
}: SyncProgressProps) {
  const isIndeterminate =
    total === 0 || status === IntegrationSyncStatus.PENDING
  const isComplete = status === IntegrationSyncStatus.COMPLETED
  const isFailed = status === IntegrationSyncStatus.FAILED
  const isProcessing = status === IntegrationSyncStatus.PROCESSING

  const pct = isIndeterminate ? 0 : Math.round((completed / total) * 100)

  return (
    <div
      className={cn("space-y-1", className)}
      role="progressbar"
      aria-valuenow={isIndeterminate ? undefined : pct}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label="Sync progress"
    >
      {!isIndeterminate && (
        <div className="flex justify-between text-xs text-muted-foreground">
          <span>
            {completed} / {total}
          </span>
          <span>{pct}%</span>
        </div>
      )}
      <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn(
            "h-full rounded-full transition-all duration-500",
            isComplete && "bg-emerald-500",
            isFailed && "bg-destructive",
            isProcessing && "bg-blue-500",
            isIndeterminate && !isProcessing && "bg-muted-foreground/30",
          )}
          style={{
            width:
              isIndeterminate && isProcessing
                ? "50%"
                : isIndeterminate
                  ? "0%"
                  : `${pct}%`,
          }}
        />
      </div>
      <p className="text-xs text-muted-foreground" aria-live="polite">
        {isComplete && "Sync complete"}
        {isFailed && "Sync failed"}
        {isProcessing &&
          (isIndeterminate
            ? "Processing..."
            : `Syncing ${completed} of ${total}`)}
        {isIndeterminate &&
          !isProcessing &&
          !isComplete &&
          !isFailed &&
          "Waiting..."}
      </p>
    </div>
  )
}

export type { SyncProgressProps }
export { SyncProgress }
