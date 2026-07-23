import {
  getOrderLifecycleStageIndex,
  isOrderLifecycleException,
  ORDER_LIFECYCLE_EXCEPTIONS,
  ORDER_LIFECYCLE_STAGES,
  type OrderStatus,
} from "@guestpost/shared"
import { AlertTriangle, Check } from "lucide-react"
import { cn } from "../lib/utils"

export interface OrderLifecycleProgressProps {
  status: OrderStatus | string
  className?: string
}

const exceptionTone = {
  CANCELLED: "border-slate-200 bg-slate-50 text-slate-700",
  REFUNDED: "border-orange-200 bg-orange-50 text-orange-800",
  DISPUTED: "border-red-200 bg-red-50 text-red-800",
} as const

export function OrderLifecycleProgress({
  status,
  className,
}: OrderLifecycleProgressProps) {
  if (isOrderLifecycleException(status)) {
    const exception = ORDER_LIFECYCLE_EXCEPTIONS[status]
    return (
      <div
        role="status"
        className={cn(
          "flex items-start gap-3 rounded-lg border px-4 py-3",
          exceptionTone[status],
          className,
        )}
      >
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <div>
          <p className="text-sm font-semibold">{exception.label}</p>
          <p className="mt-0.5 text-xs leading-5">{exception.description}</p>
        </div>
      </div>
    )
  }

  const current = getOrderLifecycleStageIndex(status)
  if (current == null) {
    return (
      <div
        role="status"
        className={cn(
          "rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800",
          className,
        )}
      >
        Lifecycle stage is unavailable. Refresh before taking an action.
      </div>
    )
  }

  return (
    <div className={cn("overflow-x-auto pb-1", className)}>
      <ol
        aria-label="Order lifecycle progress"
        className="flex min-w-[680px] items-start"
      >
        {ORDER_LIFECYCLE_STAGES.map((stage, index) => {
          const complete = index < current
          const active = index === current
          return (
            <li
              key={stage.key}
              aria-current={active ? "step" : undefined}
              className="flex flex-1 items-start last:flex-none"
            >
              <div className="flex flex-col items-center gap-1.5">
                <span
                  className={cn(
                    "flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold",
                    complete && "bg-primary text-primary-foreground",
                    active && "bg-primary/15 text-primary ring-2 ring-primary",
                    !complete && !active && "bg-muted text-muted-foreground",
                  )}
                >
                  {complete ? <Check className="h-4 w-4" /> : index + 1}
                </span>
                <span
                  className={cn(
                    "whitespace-nowrap text-[11px] text-muted-foreground",
                    active && "font-medium text-foreground",
                  )}
                >
                  {stage.label}
                </span>
              </div>
              {index < ORDER_LIFECYCLE_STAGES.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={cn(
                    "mx-1 mt-4 h-0.5 flex-1 bg-muted",
                    complete && "bg-primary",
                  )}
                />
              ) : null}
            </li>
          )
        })}
      </ol>
    </div>
  )
}
