import type { Metadata } from "next"
import { cn } from "@guestpost/ui"
import "@guestpost/ui/styles.css"
import { AuthProvider } from "../lib/auth"
import { Providers } from "../lib/providers"

export const metadata: Metadata = {
  title: "GuestPost Publisher",
  description: "Publisher dashboard for managing guest post orders.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={cn("min-h-screen bg-background font-sans antialiased")}>
        <AuthProvider>
          <Providers>{children}</Providers>
        </AuthProvider>
      </body>
    </html>
  )
}
