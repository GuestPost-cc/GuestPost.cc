"use client"

import { EmptyState } from "@guestpost/ui"
import { FileQuestion } from "lucide-react"
// Phase 7.0 — branded 404 for publisher app.
import { useRouter } from "next/navigation"

export default function NotFound() {
  const router = useRouter()
  return (
    <EmptyState
      icon={FileQuestion}
      title="Page not found"
      description="The page you're looking for doesn't exist or has been moved."
      action={{
        label: "Back to dashboard",
        onClick: () => router.push("/dashboard"),
      }}
    />
  )
}
