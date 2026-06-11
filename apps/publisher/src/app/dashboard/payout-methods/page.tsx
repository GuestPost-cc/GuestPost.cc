"use client"

import { useState } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { toast } from "sonner"
import { Plus, Building2, CreditCard, Mail, Trash2, ShieldCheck } from "lucide-react"
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Badge,
  Skeleton,
  Input,
  Label,
  ErrorState,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
  DialogDescription,
} from "@guestpost/ui"

const bankSchema = z.object({
  label: z.string().min(2, "Label required"),
  bankName: z.string().min(2, "Bank name required"),
  accountHolderName: z.string().min(2, "Account holder required"),
  accountNumber: z.string().min(4, "Account number required"),
  routingNumber: z.string().optional(),
  iban: z.string().optional(),
  swift: z.string().optional(),
})

const paypalSchema = z.object({
  label: z.string().min(2, "Label required"),
  email: z.string().email("Valid email required"),
})

type BankForm = z.infer<typeof bankSchema>
type PaypalForm = z.infer<typeof paypalSchema>

const typeIcons: Record<string, React.ElementType> = {
  bank_transfer: Building2,
  paypal: Mail,
  wise: CreditCard,
}

export default function PayoutMethodsPage() {
  const queryClient = useQueryClient()
  const [showAdd, setShowAdd] = useState(false)
  const [methodType, setMethodType] = useState<"bank_transfer" | "paypal">("bank_transfer")
  const [makeDefault, setMakeDefault] = useState(true)

  const { data: methods, isLoading, error, refetch } = useQuery({
    queryKey: ["payout-methods"],
    queryFn: () => api.publisherPayouts.listPayoutMethods(),
  })

  const bankForm = useForm<BankForm>({ resolver: zodResolver(bankSchema) })
  const paypalForm = useForm<PaypalForm>({ resolver: zodResolver(paypalSchema) })

  const createMutation = useMutation({
    mutationFn: (data: { type: string; label: string; details: Record<string, unknown>; isDefault?: boolean }) =>
      api.publisherPayouts.createPayoutMethod(data),
    onSuccess: () => {
      toast.success("Payout method added")
      setShowAdd(false)
      bankForm.reset()
      paypalForm.reset()
      queryClient.invalidateQueries({ queryKey: ["payout-methods"] })
    },
    onError: (err: any) => toast.error(err?.message ?? "Failed to add payout method"),
  })

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => api.publisherPayouts.deactivatePayoutMethod(id),
    onSuccess: () => {
      toast.success("Payout method removed")
      queryClient.invalidateQueries({ queryKey: ["payout-methods"] })
    },
    onError: (err: any) => toast.error(err?.message ?? "Failed to remove payout method"),
  })

  const submitBank = (data: BankForm) => {
    const { label, ...details } = data
    const cleaned = Object.fromEntries(Object.entries(details).filter(([, v]) => v))
    createMutation.mutate({ type: "bank_transfer", label, details: cleaned, isDefault: makeDefault })
  }

  const submitPaypal = (data: PaypalForm) => {
    createMutation.mutate({ type: "paypal", label: data.label, details: { email: data.email }, isDefault: makeDefault })
  }

  if (error)
    return <ErrorState title="Failed to load payout methods" description={(error as Error).message} onRetry={() => refetch()} />

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Payout Methods</h1>
          <p className="text-sm text-muted-foreground">Where your withdrawals get paid out</p>
        </div>
        <Button onClick={() => setShowAdd(true)}>
          <Plus className="mr-2 h-4 w-4" />
          Add Method
        </Button>
      </div>

      <div className="flex items-start gap-2 rounded-md border bg-muted/30 p-4 text-sm text-muted-foreground">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
        <p>
          Banking details are encrypted at rest (AES-256-GCM). Only the masked summary below is ever shown —
          full details are visible to no one, including platform staff, without an audited finance-only unlock.
        </p>
      </div>

      {isLoading ? (
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
            <p className="text-sm text-muted-foreground">Add a bank account or PayPal to receive withdrawals</p>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {methods.map((m) => {
            const Icon = typeIcons[m.type] ?? CreditCard
            return (
              <Card key={m.id}>
                <CardHeader className="flex flex-row items-start justify-between space-y-0 pb-2">
                  <div className="flex items-center gap-3">
                    <div className="flex h-10 w-10 items-center justify-center rounded-md bg-muted">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <CardTitle className="text-base">{m.label}</CardTitle>
                      <CardDescription className="capitalize">{m.type.replace("_", " ")}</CardDescription>
                    </div>
                  </div>
                  {m.isDefault && <Badge>Default</Badge>}
                </CardHeader>
                <CardContent className="flex items-end justify-between">
                  <div className="text-sm text-muted-foreground">
                    {m.displayDetails?.bankName ? <p>{String(m.displayDetails.bankName)}</p> : null}
                    {m.displayDetails?.last4 ? <p>Account ••••{String(m.displayDetails.last4)}</p> : null}
                    {m.displayDetails?.maskedEmail ? <p>{String(m.displayDetails.maskedEmail)}</p> : null}
                  </div>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    onClick={() => deactivateMutation.mutate(m.id)}
                    disabled={deactivateMutation.isPending}
                  >
                    <Trash2 className="mr-1 h-4 w-4" />
                    Remove
                  </Button>
                </CardContent>
              </Card>
            )
          })}
        </div>
      )}

      <Dialog open={showAdd} onOpenChange={setShowAdd}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add Payout Method</DialogTitle>
            <DialogDescription>Details are encrypted before they are stored.</DialogDescription>
          </DialogHeader>

          <div className="flex gap-2">
            <Button
              type="button"
              variant={methodType === "bank_transfer" ? "default" : "outline"}
              size="sm"
              onClick={() => setMethodType("bank_transfer")}
            >
              <Building2 className="mr-2 h-4 w-4" /> Bank Transfer
            </Button>
            <Button
              type="button"
              variant={methodType === "paypal" ? "default" : "outline"}
              size="sm"
              onClick={() => setMethodType("paypal")}
            >
              <Mail className="mr-2 h-4 w-4" /> PayPal
            </Button>
          </div>

          {methodType === "bank_transfer" ? (
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="label">Label</Label>
                <Input id="label" placeholder="My checking account" {...bankForm.register("label")} />
                {bankForm.formState.errors.label && (
                  <p className="text-sm text-destructive">{bankForm.formState.errors.label.message}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="bankName">Bank Name</Label>
                  <Input id="bankName" {...bankForm.register("bankName")} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="accountHolderName">Account Holder</Label>
                  <Input id="accountHolderName" {...bankForm.register("accountHolderName")} />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="accountNumber">Account Number / IBAN</Label>
                <Input id="accountNumber" {...bankForm.register("accountNumber")} />
                {bankForm.formState.errors.accountNumber && (
                  <p className="text-sm text-destructive">{bankForm.formState.errors.accountNumber.message}</p>
                )}
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="routingNumber">Routing Number (US)</Label>
                  <Input id="routingNumber" {...bankForm.register("routingNumber")} />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="swift">SWIFT / BIC</Label>
                  <Input id="swift" {...bankForm.register("swift")} />
                </div>
              </div>
            </div>
          ) : (
            <div className="space-y-3 py-2">
              <div className="space-y-1.5">
                <Label htmlFor="plabel">Label</Label>
                <Input id="plabel" placeholder="My PayPal" {...paypalForm.register("label")} />
                {paypalForm.formState.errors.label && (
                  <p className="text-sm text-destructive">{paypalForm.formState.errors.label.message}</p>
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="pemail">PayPal Email</Label>
                <Input id="pemail" type="email" {...paypalForm.register("email")} />
                {paypalForm.formState.errors.email && (
                  <p className="text-sm text-destructive">{paypalForm.formState.errors.email.message}</p>
                )}
              </div>
            </div>
          )}

          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={makeDefault} onChange={(e) => setMakeDefault(e.target.checked)} />
            Set as default payout method
          </label>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowAdd(false)}>
              Cancel
            </Button>
            <Button
              onClick={
                methodType === "bank_transfer"
                  ? bankForm.handleSubmit(submitBank)
                  : paypalForm.handleSubmit(submitPaypal)
              }
              disabled={createMutation.isPending}
            >
              {createMutation.isPending ? "Saving..." : "Add Method"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
