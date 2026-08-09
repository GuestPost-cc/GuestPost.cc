"use client"

import { payoutErrorPresentation } from "@guestpost/api-client"
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  Input,
  Label,
  Skeleton,
} from "@guestpost/ui"
import { zodResolver } from "@hookform/resolvers/zod"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import {
  Building2,
  CreditCard,
  ExternalLink,
  Plus,
  RotateCcw,
  ShieldCheck,
  Trash2,
} from "lucide-react"
import { useState } from "react"
import { useForm } from "react-hook-form"
import { toast } from "sonner"
import { z } from "zod"
import { api } from "../../../lib/api"

function showPayoutError(error: unknown, fallback: string) {
  const presentation = payoutErrorPresentation(error, fallback)
  toast.error(presentation.message, {
    description: presentation.requestId
      ? `Request ID: ${presentation.requestId}`
      : undefined,
  })
}

const bankSchema = z.object({
  label: z.string().min(2, "Label required"),
  bankName: z.string().min(2, "Bank name required"),
  accountHolderName: z.string().min(2, "Account holder required"),
  accountNumber: z.string().min(4, "Account number required"),
  routingNumber: z.string().optional(),
  iban: z.string().optional(),
  swift: z.string().optional(),
})

type BankForm = z.infer<typeof bankSchema>

const typeIcons: Record<string, React.ElementType> = {
  bank_transfer: Building2,
  wise: CreditCard,
  stripe_connect: CreditCard,
}

export default function PayoutMethodsPage() {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [makeDefault, setMakeDefault] = useState(true)

  const {
    data: methods,
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["payout-methods"],
    queryFn: () => api.publisherPayouts.listPayoutMethods(true),
  })

  const {
    data: stripeStatus,
    isLoading: stripeStatusLoading,
    error: stripeStatusError,
    refetch: refetchStripeStatus,
  } = useQuery({
    queryKey: ["stripe-connect-status"],
    queryFn: () => api.publisherPayouts.getStripeConnectStatus(),
  })

  const stripeOnboarding = useMutation({
    mutationFn: () => api.publisherPayouts.createStripeConnectOnboardingLink(),
    onSuccess: ({ url }) => window.location.assign(url),
    onError: (error: unknown) =>
      showPayoutError(error, "Could not start secure Stripe onboarding"),
  })
  const stripeRefresh = useMutation({
    mutationFn: () => api.publisherPayouts.refreshStripeConnectStatus(),
    onSuccess: () => {
      void refetchStripeStatus()
      void queryClient.invalidateQueries({ queryKey: ["payout-methods"] })
      toast.success("Stripe payout status refreshed")
    },
    onError: (error: unknown) =>
      showPayoutError(error, "Could not refresh Stripe status"),
  })

  const bankForm = useForm<BankForm>({ resolver: zodResolver(bankSchema) })

  const createMutation = useMutation({
    mutationFn: (data: {
      type: "bank_transfer"
      label: string
      details: Record<string, unknown>
      isDefault?: boolean
    }) => api.publisherPayouts.createPayoutMethod(data),
    onSuccess: () => {
      toast.success("Payout method added")
      setShowAdd(false)
      bankForm.reset()
      queryClient.invalidateQueries({ queryKey: ["payout-methods"] })
    },
    onError: (error: unknown) =>
      showPayoutError(error, "Failed to add payout method"),
  })

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api.publisherPayouts.deactivatePayoutMethod(id),
    onSuccess: ({ replayed }) => {
      toast.success(
        replayed
          ? "Payout method was already disabled"
          : "Payout method disabled",
      )
      queryClient.invalidateQueries({ queryKey: ["payout-methods"] })
    },
    onError: (error: unknown) =>
      showPayoutError(error, "Failed to disable payout method"),
  })

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => api.publisherPayouts.reactivatePayoutMethod(id),
    onSuccess: ({ replayed }) => {
      toast.success(
        replayed ? "Payout method was already active" : "Payout method enabled",
      )
      queryClient.invalidateQueries({ queryKey: ["payout-methods"] })
    },
    onError: (error: unknown) =>
      showPayoutError(error, "Failed to enable payout method"),
  })

  const submitBank = (data: BankForm) => {
    if (!canAddManualBank) {
      toast.error(
        "Manual payout setup is temporarily unavailable. Refresh the page before retrying.",
      )
      return
    }
    const { label, ...details } = data
    const cleaned = Object.fromEntries(
      Object.entries(details).filter(([, v]) => v),
    )
    createMutation.mutate({
      type: "bank_transfer",
      label,
      details: cleaned,
      isDefault: makeDefault,
    })
  }

  const stripeMethodDisabled = methods?.some(
    (method) => method.type === "stripe_connect" && !method.isActive,
  )
  const canAddManualBank =
    stripeStatus?.manualBankPayoutsAvailable === true &&
    stripeStatus.payoutActionsAvailable === true

  const loadError = error ?? stripeStatusError
  const loadPresentation = loadError
    ? payoutErrorPresentation(loadError, "Unable to verify payout setup")
    : null
  if (loadError)
    return (
      <ErrorState
        title="Cannot verify payout setup"
        description={`${loadPresentation?.message ?? "Payout setup could not be verified."} No setup action is available until both checks succeed.${
          loadPresentation?.requestId
            ? ` Request ID: ${loadPresentation.requestId}`
            : ""
        }`}
        onRetry={() => {
          void refetch()
          void refetchStripeStatus()
        }}
      />
    )

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Payout Methods</h1>
          <p className="text-sm text-muted-foreground">
            Where your withdrawals get paid out
          </p>
        </div>
        {canAddManualBank ? (
          <Button onClick={() => setShowAdd(true)}>
            <Plus className="mr-2 h-4 w-4" />
            Add Method
          </Button>
        ) : null}
      </div>

      {stripeStatus?.available ? (
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between gap-4">
              <div>
                <CardTitle>Stripe bank payouts</CardTitle>
                <CardDescription>
                  Stripe securely collects and verifies your bank details.
                  GuestPost does not receive or store the full account number.
                </CardDescription>
              </div>
              <Badge
                variant={
                  stripeStatus.status === "ENABLED" && !stripeMethodDisabled
                    ? "success"
                    : "secondary"
                }
              >
                {stripeStatus.status === "ENABLED" && stripeMethodDisabled
                  ? "Payouts disabled"
                  : stripeStatus.status === "ENABLED"
                    ? "Ready"
                    : stripeStatus.connected
                      ? "Setup required"
                      : "Not connected"}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              <p>Your withdrawal fee: $0.00 during the initial rollout.</p>
              <p>Stripe processing fees are paid by GuestPost.</p>
              {stripeStatus.payoutActionsAvailable !== true ? (
                <p className="font-medium text-amber-700 dark:text-amber-300">
                  New payout setup and withdrawals are temporarily paused by
                  operations.
                </p>
              ) : null}
              {stripeStatus.requirementsDue.length > 0 ? (
                <p>
                  {stripeStatus.requirementsDue.length} verification item(s)
                  remain.
                </p>
              ) : null}
            </div>
            <div className="flex gap-2">
              {stripeStatus.connected ? (
                <Button
                  variant="outline"
                  onClick={() => stripeRefresh.mutate()}
                  disabled={stripeRefresh.isPending}
                >
                  Refresh status
                </Button>
              ) : null}
              {stripeStatus.status !== "ENABLED" ? (
                <Button
                  onClick={() => stripeOnboarding.mutate()}
                  disabled={
                    stripeOnboarding.isPending ||
                    stripeStatus.payoutActionsAvailable !== true
                  }
                >
                  <ExternalLink className="mr-2 h-4 w-4" />
                  {stripeStatus.connected ? "Continue setup" : "Connect Stripe"}
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : null}

      {stripeStatus &&
      !stripeStatus.available &&
      !stripeStatus.manualBankPayoutsAvailable ? (
        <Card>
          <CardHeader>
            <CardTitle>Payout setup is temporarily unavailable</CardTitle>
            <CardDescription>
              New payout destinations are disabled by operations. Existing
              legacy methods remain visible below and can be disabled, but no
              new withdrawal can use them. Contact support if this persists.
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        <p>
          Stripe-hosted setup keeps full bank details outside GuestPost. Legacy
          methods, when enabled by operations, remain encrypted at rest and
          require an audited finance-only unlock.
        </p>
      </div>

      {isLoading || stripeStatusLoading ? (
        <div className="grid gap-4 md:grid-cols-2">
          {[1, 2].map((i) => (
            <Skeleton key={i} className="h-32" />
          ))}
        </div>
      ) : !methods || methods.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16 text-center">
            <CreditCard className="mb-3 h-10 w-10 text-muted-foreground/50" />
            <p className="font-medium">No payout methods yet</p>
            <p className="text-sm text-muted-foreground">
              {stripeStatus?.available
                ? "Connect Stripe above to receive verified bank payouts."
                : canAddManualBank
                  ? "Add a manual bank destination above to receive payouts."
                  : "Payout setup is temporarily unavailable. Retry later or contact support."}
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {methods.map((m) => {
            const Icon = typeIcons[m.type] ?? CreditCard
            const eligibility = m.withdrawalEligibility
            return (
              <Card key={m.id}>
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{m.label}</CardTitle>
                      <CardDescription className="capitalize">
                        {m.type.replace("_", " ")}
                      </CardDescription>
                    </div>
                  </div>
                  <div className="flex gap-2">
                    {!m.isActive ? (
                      <Badge variant="secondary">Disabled</Badge>
                    ) : null}
                    {m.isActive && !eligibility.executable ? (
                      <Badge variant="warning">Unavailable</Badge>
                    ) : null}
                    {m.isDefault ? <Badge>Default</Badge> : null}
                  </div>
                </CardHeader>
                <CardContent className="flex items-end justify-between">
                  <div className="text-sm text-muted-foreground">
                    {m.displayDetails?.bankName ? (
                      <p>{String(m.displayDetails.bankName)}</p>
                    ) : null}
                    {m.displayDetails?.last4 ? (
                      <p>Account ••••{String(m.displayDetails.last4)}</p>
                    ) : null}
                    {m.displayDetails?.maskedEmail ? (
                      <p>{String(m.displayDetails.maskedEmail)}</p>
                    ) : null}
                    {!eligibility.executable ? (
                      <p className="mt-2 max-w-sm text-xs">
                        {eligibility.message}
                      </p>
                    ) : null}
                  </div>
                  {m.isActive ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="text-destructive hover:text-destructive"
                      onClick={() => deactivateMutation.mutate(m.id)}
                      disabled={
                        deactivateMutation.isPending ||
                        reactivateMutation.isPending
                      }
                    >
                      <Trash2 className="mr-1 h-4 w-4" />
                      Disable
                    </Button>
                  ) : eligibility.canReactivate ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => reactivateMutation.mutate(m.id)}
                      disabled={
                        deactivateMutation.isPending ||
                        reactivateMutation.isPending
                      }
                    >
                      <RotateCcw className="mr-1 h-4 w-4" />
                      Enable
                    </Button>
                  ) : (
                    <span className="text-xs font-medium text-muted-foreground">
                      Cannot enable
                    </span>
                  )}
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Dialog open={showAdd && canAddManualBank} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Payout Method</DialogTitle>
            <DialogDescription>
              Add a manual bank destination. Details are encrypted before they
              are stored, and availability is revalidated by the server when you
              request a withdrawal.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label htmlFor="label">Label</Label>
              <Input
                id="label"
                placeholder="My checking account"
                {...bankForm.register("label")}
              />
              {bankForm.formState.errors.label && (
                <p className="text-sm text-destructive">
                  {bankForm.formState.errors.label.message}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="bankName">Bank Name</Label>
                <Input id="bankName" {...bankForm.register("bankName")} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="accountHolderName">Account Holder</Label>
                <Input
                  id="accountHolderName"
                  {...bankForm.register("accountHolderName")}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="accountNumber">Account Number / IBAN</Label>
              <Input
                id="accountNumber"
                {...bankForm.register("accountNumber")}
              />
              {bankForm.formState.errors.accountNumber && (
                <p className="text-sm text-destructive">
                  {bankForm.formState.errors.accountNumber.message}
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label htmlFor="routingNumber">Routing Number (US)</Label>
                <Input
                  id="routingNumber"
                  {...bankForm.register("routingNumber")}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="swift">SWIFT / BIC</Label>
                <Input id="swift" {...bankForm.register("swift")} />
              </div>
            </div>
          </div>

          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
            />
            Set as default payout method
          </label>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button
              onClick={bankForm.handleSubmit(submitBank)}
              disabled={createMutation.isPending || !canAddManualBank}
            >
              {createMutation.isPending ? "Saving..." : "Add Method"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
