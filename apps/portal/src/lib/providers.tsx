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
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30 * 1000,
            retry: 1,
          },
        },
      }),
  )

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
  const active = useIsFetching() + useIsMutating() > 0
  return <GlobalLoadingBar active={active} />
}
