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

import { BRIEF_FIELDS, type ServiceTypeKey } from "@guestpost/shared"
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

  // Tag-list helper: comma OR newline-separated → trimmed array.
  const parseTags = (raw: string) =>
    raw
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50)

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
            <Textarea
              id={`brief-${f.name}`}
              rows={2}
              placeholder="Comma or newline separated"
              value={(state[f.name] as string[] | undefined)?.join(", ") ?? ""}
              onChange={(e) => update(f.name, parseTags(e.target.value))}
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
