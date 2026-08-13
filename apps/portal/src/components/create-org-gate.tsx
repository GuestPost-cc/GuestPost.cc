"use client"

import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Input,
  Label,
} from "@guestpost/ui"
import { useMutation } from "@tanstack/react-query"
import { Building2 } from "lucide-react"
import { useState } from "react"
import { api } from "../lib/api"

// Signup normally provisions a customer organization, wallet, and OWNER
// membership atomically. This gate is the recovery path for legacy or repaired
// accounts whose active organization projection is missing; money actions
// remain unavailable until that invariant has been restored.
export function CreateOrgGate({ onCreated }: { onCreated: () => void }) {
  const [name, setName] = useState("")

  const slugify = (s: string) =>
    s
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)

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
            Campaigns, orders, and your wallet all live under an organization.
            You&apos;ll be its owner.
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
                {(createMutation.error as Error).message ||
                  "Could not create organization"}
              </p>
            )}
            <Button
              type="submit"
              className="w-full"
              disabled={createMutation.isPending || name.trim().length < 2}
            >
              {createMutation.isPending ? "Creating..." : "Create organization"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
