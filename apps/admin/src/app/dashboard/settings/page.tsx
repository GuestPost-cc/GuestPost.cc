"use client"

import { useState } from "react"
import { Button } from "@guestpost/ui"

export default function SettingsPage() {
  const [email, setEmail] = useState("")
  const [password, setPassword] = useState("")

  return (
    <div>
      <h1 className="mb-8 text-3xl font-bold tracking-tight">Settings</h1>

      <div className="grid gap-8 max-w-2xl">
        <div className="rounded-lg border p-6">
          <h2 className="mb-4 text-lg font-semibold">Platform Info</h2>
          <dl className="space-y-3 text-sm">
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Version</dt>
              <dd className="font-medium">1.0.0</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">API URL</dt>
              <dd className="font-mono text-xs">{process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Environment</dt>
              <dd className="font-medium">{process.env.NODE_ENV || "development"}</dd>
            </div>
          </dl>
        </div>

        <div className="rounded-lg border p-6">
          <h2 className="mb-4 text-lg font-semibold">Account Details</h2>
          <p className="mb-4 text-sm text-muted-foreground">
            Manage your account settings. For now, edit your profile through the identity API.
          </p>
          <div className="grid gap-3">
            <input
              type="email" placeholder="New email" value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="flex h-10 rounded-md border bg-background px-3 py-2 text-sm"
            />
            <input
              type="password" placeholder="New password" value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="flex h-10 rounded-md border bg-background px-3 py-2 text-sm"
            />
            <Button disabled>Save Changes</Button>
          </div>
        </div>
      </div>
    </div>
  )
}
