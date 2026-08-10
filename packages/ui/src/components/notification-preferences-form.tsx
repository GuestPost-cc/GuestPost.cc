"use client"

import { Loader2, LockKeyhole } from "lucide-react"
import { Button } from "./button"
import { Label } from "./label"
import { Separator } from "./separator"
import { Switch } from "./switch"

export type NotificationPreferenceCategory =
  | "SECURITY"
  | "ACCOUNT"
  | "ORDERS"
  | "BILLING"
  | "SETTLEMENTS"
  | "PAYOUTS"
  | "MARKETPLACE"
  | "SUPPORT"
  | "STAFF_ALERTS"
  | "PRODUCT"

export interface NotificationPreferenceValue {
  category: NotificationPreferenceCategory
  mutable: boolean
  inApp: boolean
  email: boolean
}

export interface NotificationPreferencesFormProps {
  preferences: NotificationPreferenceValue[]
  loading?: boolean
  saving?: boolean
  onChange: (preferences: NotificationPreferenceValue[]) => void
  onSave: () => void
}

const categoryCopy: Record<
  NotificationPreferenceCategory,
  { label: string; description: string }
> = {
  SECURITY: {
    label: "Security",
    description: "Important account and access protection messages.",
  },
  ACCOUNT: {
    label: "Account",
    description: "Invitations, membership, and account changes.",
  },
  ORDERS: {
    label: "Orders",
    description:
      "Order progress, content reviews, deadlines, and cancellations.",
  },
  BILLING: {
    label: "Billing",
    description: "Deposits, refunds, disputes, and payment receipts.",
  },
  SETTLEMENTS: {
    label: "Settlements",
    description: "Settlement releases, debt, and earnings adjustments.",
  },
  PAYOUTS: {
    label: "Payouts",
    description: "Withdrawal approval, processing, completion, and failures.",
  },
  MARKETPLACE: {
    label: "Marketplace",
    description: "Listing reviews, availability, and marketplace updates.",
  },
  SUPPORT: {
    label: "Support",
    description: "Public support replies and ticket status changes.",
  },
  STAFF_ALERTS: {
    label: "Staff risk alerts",
    description: "Reconciliation, chargeback, fraud, and operational alerts.",
  },
  PRODUCT: {
    label: "Product updates",
    description: "Optional feature announcements and product guidance.",
  },
}

export function NotificationPreferencesForm({
  preferences,
  loading = false,
  saving = false,
  onChange,
  onSave,
}: NotificationPreferencesFormProps) {
  const update = (
    category: NotificationPreferenceCategory,
    channel: "inApp" | "email",
    enabled: boolean,
  ) => {
    onChange(
      preferences.map((preference) =>
        preference.category === category && preference.mutable
          ? { ...preference, [channel]: enabled }
          : preference,
      ),
    )
  }

  if (loading) {
    return (
      <div className="flex min-h-24 items-center justify-center text-sm text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Loading preferences…
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-end gap-3 px-1 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span className="text-left">Category</span>
        <span>In app</span>
        <span>Email</span>
      </div>
      {preferences.map((preference, index) => {
        const copy = categoryCopy[preference.category]
        const id = preference.category.toLowerCase()
        return (
          <div key={preference.category}>
            {index > 0 && <Separator className="mb-4" />}
            <div className="grid grid-cols-[minmax(0,1fr)_4.5rem_4.5rem] items-center gap-3 px-1">
              <div className="min-w-0">
                <Label className="flex items-center gap-1.5 font-medium">
                  {copy.label}
                  {!preference.mutable && (
                    <LockKeyhole
                      className="h-3.5 w-3.5 text-muted-foreground"
                      aria-label="Required notification"
                    />
                  )}
                </Label>
                <p className="mt-1 text-sm text-muted-foreground">
                  {copy.description}
                </p>
              </div>
              <div className="flex justify-center">
                <Switch
                  id={`${id}-in-app`}
                  aria-label={`${copy.label} in-app notifications`}
                  checked={preference.inApp}
                  disabled={!preference.mutable || saving}
                  onCheckedChange={(enabled) =>
                    update(preference.category, "inApp", enabled)
                  }
                />
              </div>
              <div className="flex justify-center">
                <Switch
                  id={`${id}-email`}
                  aria-label={`${copy.label} email notifications`}
                  checked={preference.email}
                  disabled={!preference.mutable || saving}
                  onCheckedChange={(enabled) =>
                    update(preference.category, "email", enabled)
                  }
                />
              </div>
            </div>
          </div>
        )
      })}
      <div className="flex justify-end pt-2">
        <Button
          type="button"
          onClick={onSave}
          disabled={loading || saving || preferences.length === 0}
        >
          {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save notification preferences
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Required security, financial, deadline, and staff risk notices may still
        be delivered when needed to protect your account or the platform.
      </p>
    </div>
  )
}
