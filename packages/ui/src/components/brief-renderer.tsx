// Read-mode mirror of apps/portal/src/components/BriefForm.tsx. Drives off
// the same field registry in @guestpost/shared/briefs so a new field on a
// brief schema surfaces in both the editor and the renderer without a
// duplicate edit.
//
// Used by portal/publisher/admin order detail pages to render the
// structured `Order.briefData` JSONB. Falls back to a legacy display
// (title/instructions/targetUrl/anchorText) when briefData is NULL — older
// orders predate Phase 6 and only have the denormalized mirror fields.

import {
  BRIEF_FIELDS,
  type BriefFieldSpec,
  type ServiceTypeKey,
} from "@guestpost/shared"
import { cn } from "../lib/utils"

export interface LegacyBriefFallback {
  title?: string | null
  instructions?: string | null
  targetUrl?: string | null
  anchorText?: string | null
}

export interface BriefRendererProps {
  serviceType?: string | null
  briefData?: Record<string, unknown> | null
  fallback?: LegacyBriefFallback
  className?: string
}

export function BriefRenderer({
  serviceType,
  briefData,
  fallback,
  className,
}: BriefRendererProps) {
  const fields =
    (serviceType && BRIEF_FIELDS[serviceType as ServiceTypeKey]) || null

  if (!briefData || !fields) {
    return <LegacyBriefDisplay fallback={fallback} className={className} />
  }

  const populated = fields.filter((f) => hasValue(briefData[f.name]))
  if (populated.length === 0) {
    return <LegacyBriefDisplay fallback={fallback} className={className} />
  }

  return (
    <dl
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-[max-content_1fr] sm:gap-x-6",
        className,
      )}
    >
      {populated.map((field) => (
        <BriefFieldRow
          key={field.name}
          field={field}
          value={briefData[field.name]}
        />
      ))}
    </dl>
  )
}

function BriefFieldRow({
  field,
  value,
}: {
  field: BriefFieldSpec
  value: unknown
}) {
  return (
    <>
      <dt className="text-sm font-medium text-muted-foreground sm:pt-0.5">
        {field.label}
      </dt>
      <dd className="text-sm">
        <FieldValue field={field} value={value} />
      </dd>
    </>
  )
}

function FieldValue({
  field,
  value,
}: {
  field: BriefFieldSpec
  value: unknown
}) {
  if (field.widget === "url" && typeof value === "string") {
    return (
      <a
        href={value}
        target="_blank"
        rel="noreferrer noopener"
        className="break-all text-primary underline-offset-2 hover:underline"
      >
        {value}
      </a>
    )
  }

  if (field.widget === "tags" && Array.isArray(value)) {
    return (
      <div className="flex flex-wrap gap-1">
        {value.map((tag, i) => (
          <span
            key={`${field.name}-${i}`}
            className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs"
          >
            {String(tag)}
          </span>
        ))}
      </div>
    )
  }

  if (field.widget === "address" && value && typeof value === "object") {
    return <AddressValue value={value as Record<string, unknown>} />
  }

  if (field.widget === "textarea" && typeof value === "string") {
    return <p className="whitespace-pre-wrap">{value}</p>
  }

  if (field.widget === "select" && typeof value === "string") {
    return <span>{value.replace(/_/g, " ")}</span>
  }

  if (field.widget === "number" && typeof value === "number") {
    return <span>{value.toLocaleString()}</span>
  }

  if (typeof value === "string" || typeof value === "number") {
    return <span>{String(value)}</span>
  }

  if (typeof value === "boolean") {
    return <span>{value ? "Yes" : "No"}</span>
  }

  // Unknown shape — render JSON as a last resort rather than crash.
  return <code className="text-xs">{JSON.stringify(value)}</code>
}

function AddressValue({ value }: { value: Record<string, unknown> }) {
  const lines = [
    value.street,
    [value.city, value.region].filter(Boolean).join(", "),
    [value.postalCode, value.country].filter(Boolean).join(" "),
  ].filter((line) => typeof line === "string" && line.length > 0)
  return (
    <div className="space-y-0.5">
      {lines.map((line, i) => (
        <div key={i}>{line as string}</div>
      ))}
    </div>
  )
}

function LegacyBriefDisplay({
  fallback,
  className,
}: {
  fallback?: LegacyBriefFallback
  className?: string
}) {
  if (!fallback) {
    return (
      <p className={cn("text-sm italic text-muted-foreground", className)}>
        No brief on file for this order.
      </p>
    )
  }

  const { title, instructions, targetUrl, anchorText } = fallback
  if (!title && !instructions && !targetUrl && !anchorText) {
    return (
      <p className={cn("text-sm italic text-muted-foreground", className)}>
        No brief on file for this order.
      </p>
    )
  }

  return (
    <dl
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-[max-content_1fr] sm:gap-x-6",
        className,
      )}
    >
      {title && (
        <>
          <dt className="text-sm font-medium text-muted-foreground sm:pt-0.5">
            Title
          </dt>
          <dd className="text-sm">{title}</dd>
        </>
      )}
      {targetUrl && (
        <>
          <dt className="text-sm font-medium text-muted-foreground sm:pt-0.5">
            Target URL
          </dt>
          <dd className="text-sm">
            <a
              href={targetUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="break-all text-primary underline-offset-2 hover:underline"
            >
              {targetUrl}
            </a>
          </dd>
        </>
      )}
      {anchorText && (
        <>
          <dt className="text-sm font-medium text-muted-foreground sm:pt-0.5">
            Anchor text
          </dt>
          <dd className="text-sm">{anchorText}</dd>
        </>
      )}
      {instructions && (
        <>
          <dt className="text-sm font-medium text-muted-foreground sm:pt-0.5">
            Instructions
          </dt>
          <dd className="whitespace-pre-wrap text-sm">{instructions}</dd>
        </>
      )}
    </dl>
  )
}

function hasValue(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === "string") return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  if (typeof v === "object")
    return Object.values(v).some((nested) => hasValue(nested))
  return true
}
