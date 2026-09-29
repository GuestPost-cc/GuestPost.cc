"use client"

import { GlobalLoadingBar } from "@guestpost/ui"
import {
  QueryClient,
  QueryClientProvider,
  useIsFetching,
  useIsMutating,
} from "@tanstack/react-query"
import { ThemeProvider } from "next-themes"
import { type ReactNode, useState } from "react"
import { Toaster } from "sonner"

export function Providers({
  children,
  nonce,
}: {
  children: ReactNode
  nonce?: string
}) {
  const [queryClient] = useState(() => new QueryClient())

  return (
    <QueryClientProvider client={queryClient}>
      <ActivityLoadingBar />
      <ThemeProvider
        attribute="class"
        defaultTheme="system"
        enableSystem
        nonce={nonce}
      >
        {children}
        <Toaster richColors closeButton />
      </ThemeProvider>
    </QueryClientProvider>
  )
}

function ActivityLoadingBar() {
  const fetching = useIsFetching({
    predicate: (query) =>
      query.state.data === undefined || query.meta?.globalLoadingBar === true,
  })
  const active = fetching + useIsMutating() > 0
  return <GlobalLoadingBar active={active} />
}
