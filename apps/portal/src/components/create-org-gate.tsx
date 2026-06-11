"use client"

import { useState } from "react"
import { useMutation } from "@tanstack/react-query"
import { api } from "../lib/api"
import { Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Input, Label } from "@guestpost/ui"
import { Building2 } from "lucide-react"

// A freshly registered customer has no organization, and every money action
// (deposit, checkout, orders) requires the OWNER role on one. This gate
// blocks the dashboard until the org exists — previously those actions all
// returned 403 with no path forward (audit A-2).
export function CreateOrgGate({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("")

  const slugify = (s: string) =>
    s.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48)

  const createMutation = useMutation({
    mutationFn: () =>
      api.identity.createOrganization({
        name: name.trim(),
        // Suffix avoids slug collisions without leaking other orgs' existence
        slug: `${slugify(name) || "org"}-${Math.random().toString(36).slice(2, 8)}`,
      }),
    onSuccess: onCreated,
  })

  return (
    <div className="flex min-h-[70vh] items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader>
          <div className="mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
            <Building2 className="h-5 w-5 text-primary" />
          </div>
          <CardTitle>Create your organization</CardTitle>
          <CardDescription>
            Campaigns, orders, and your wallet all live under an organization. You&apos;ll be its owner.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault()
              if (name.trim().length >= 2) createMutation.mutate()
            }}
            className="space-y-4"
          >
            <div className="space-y-2">
              <Label htmlFor="org-name">Organization name</Label>
              <Input
                id="org-name"
                placeholder="e.g. Acme Marketing"
                value={name}
                onChange={(e) => setName(e.target.value)}
                minLength={2}
                maxLength={80}
                required
                autoFocus
              />
            </div>
            {createMutation.isError && (
              <p className="text-sm text-destructive">
                {(createMutation.error as Error).message || "Could not create organization"}
              </p>
            )}
            <Button type="submit" className="w-full" disabled={createMutation.isPending || name.trim().length < 2}>
              {createMutation.isPending ? "Creating..." : "Create organization"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
