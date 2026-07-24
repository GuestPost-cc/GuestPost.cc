"use client"

// Phase 6: per-`ServiceType` brief form. Renders only the fields relevant to
// the selected service. The shape mirrors the Zod schemas in
// @guestpost/shared/briefs so the server can re-parse the submitted payload
// authoritatively — this component is intentionally NOT the source of
// truth for required fields; the server is.
//
// The component returns a single onChange(briefData) call with the latest
// payload — callers store it on the wizard's form state and forward to
// orders.create({ briefData }).
//
// We deliberately keep this lightweight (no react-hook-form, no full Zod
// resolver) because the parent wizard already manages state and the server
// validates definitively on submit. Local validation here is best-effort.

import {
  BRIEF_FIELDS,
  normalizeTargetKeywordsInput,
  type ServiceTypeKey,
  TARGET_KEYWORD_LIMIT,
  TARGET_KEYWORD_MAX_LENGTH,
} from "@guestpost/shared"
import {
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from "@guestpost/ui"
import { useEffect, useState } from "react"

export type BriefServiceType = ServiceTypeKey

export interface BriefFormProps {
  serviceType: BriefServiceType
  value?: Record<string, unknown>
  onChange(value: Record<string, unknown>): void
}

export function BriefForm({ serviceType, value, onChange }: BriefFormProps) {
  const fields = BRIEF_FIELDS[serviceType] ?? []
  const [state, setState] = useState<Record<string, unknown>>(value ?? {})

  useEffect(() => {
    setState(value ?? {})
  }, [value])

  // Bubble every change up; parent decides when to send.
  const update = (name: string, v: unknown) => {
    const next = { ...state, [name]: v }
    setState(next)
    onChange(next)
  }

  return (
    <div className="space-y-4">
      {fields.map((f) => (
        <div key={f.name} className="space-y-1">
          <Label htmlFor={`brief-${f.name}`}>
            {f.label}{" "}
            {f.required && <span className="text-destructive">*</span>}
          </Label>
          {f.widget === "text" && (
            <Input
              id={`brief-${f.name}`}
              value={(state[f.name] as string) ?? ""}
              maxLength={f.maxLength}
              placeholder={f.placeholder}
              onChange={(e) => update(f.name, e.target.value)}
            />
          )}
          {f.widget === "textarea" && (
            <Textarea
              id={`brief-${f.name}`}
              value={(state[f.name] as string) ?? ""}
              maxLength={f.maxLength}
              rows={3}
              placeholder={f.placeholder}
              onChange={(e) => update(f.name, e.target.value)}
            />
          )}
          {f.widget === "url" && (
            <Input
              id={`brief-${f.name}`}
              type="url"
              value={(state[f.name] as string) ?? ""}
              placeholder={f.placeholder ?? "https://"}
              onChange={(e) => update(f.name, e.target.value)}
            />
          )}
          {f.widget === "number" && (
            <Input
              id={`brief-${f.name}`}
              type="number"
              min={f.min}
              max={f.max}
              value={(state[f.name] as number | undefined) ?? ""}
              onChange={(e) =>
                update(
                  f.name,
                  e.target.value === "" ? undefined : Number(e.target.value),
                )
              }
            />
          )}
          {f.widget === "select" && (
            <Select
              value={(state[f.name] as string) ?? ""}
              onValueChange={(v) => update(f.name, v)}
            >
              <SelectTrigger id={`brief-${f.name}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {(f.options ?? []).map((o) => (
                  <SelectItem key={o} value={o}>
                    {o.replace(/_/g, " ")}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {f.widget === "tags" && (
            <KeywordInput
              id={`brief-${f.name}`}
              value={(state[f.name] as string[] | undefined) ?? []}
              onChange={(keywords) => update(f.name, keywords)}
            />
          )}
          {f.widget === "address" && (
            <AddressBlock
              value={(state[f.name] as Record<string, string>) ?? {}}
              onChange={(v) => update(f.name, v)}
            />
          )}
          {f.helper && (
            <p className="text-xs text-muted-foreground">{f.helper}</p>
          )}
        </div>
      ))}
    </div>
  )
}

function KeywordInput({
  id,
  value,
  onChange,
}: {
  id: string
  value: string[]
  onChange(value: string[]): void
}) {
  const [raw, setRaw] = useState(() => value.join(", "))
  const [focused, setFocused] = useState(false)
  const normalized = normalizeTargetKeywordsInput(raw)
  const keywords = Array.isArray(normalized)
    ? normalized.filter((value): value is string => typeof value === "string")
    : []
  const tooMany = keywords.length > TARGET_KEYWORD_LIMIT
  const longKeyword = keywords.find(
    (keyword) => keyword.length > TARGET_KEYWORD_MAX_LENGTH,
  )
  const error = tooMany
    ? `Use no more than ${TARGET_KEYWORD_LIMIT} target keywords.`
    : longKeyword
      ? `Each keyword must be ${TARGET_KEYWORD_MAX_LENGTH} characters or fewer.`
      : null
  const errorId = `${id}-error`

  useEffect(() => {
    if (!focused) setRaw(value.join(", "))
  }, [focused, value])

  return (
    <div className="space-y-1.5">
      <Textarea
        id={id}
        rows={2}
        placeholder="Type keywords separated by commas or new lines"
        value={raw}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? errorId : undefined}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false)
          setRaw(keywords.join(", "))
        }}
        onChange={(event) => {
          const nextRaw = event.target.value
          setRaw(nextRaw)
          const next = normalizeTargetKeywordsInput(nextRaw)
          onChange(Array.isArray(next) ? (next as string[]) : [])
        }}
      />
      <div className="flex items-center justify-between gap-3 text-xs">
        <span
          id={errorId}
          className={error ? "text-destructive" : "text-muted-foreground"}
          role={error ? "alert" : undefined}
        >
          {error ?? "Duplicates are removed automatically."}
        </span>
        <span
          className={
            tooMany ? "font-medium text-destructive" : "text-muted-foreground"
          }
        >
          {keywords.length}/{TARGET_KEYWORD_LIMIT}
        </span>
      </div>
    </div>
  )
}

function AddressBlock({
  value,
  onChange,
}: {
  value: Record<string, string>
  onChange(v: Record<string, string>): void
}) {
  const set = (k: string, v: string) => onChange({ ...value, [k]: v })
  return (
    <div className="grid grid-cols-2 gap-2">
      <Input
        placeholder="Street"
        value={value.street ?? ""}
        onChange={(e) => set("street", e.target.value)}
      />
      <Input
        placeholder="City"
        value={value.city ?? ""}
        onChange={(e) => set("city", e.target.value)}
      />
      <Input
        placeholder="State / region"
        value={value.region ?? ""}
        onChange={(e) => set("region", e.target.value)}
      />
      <Input
        placeholder="Postal code"
        value={value.postalCode ?? ""}
        onChange={(e) => set("postalCode", e.target.value)}
      />
      <Input
        className="col-span-2"
        placeholder="Country"
        value={value.country ?? ""}
        onChange={(e) => set("country", e.target.value)}
      />
    </div>
  )
}
