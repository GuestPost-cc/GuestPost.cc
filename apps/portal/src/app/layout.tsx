import { cn } from "@guestpost/ui"
import type { Metadata } from "next"
import { connection } from "next/server"
import "@guestpost/ui/styles.css"
import { AuthProvider } from "../lib/auth"
import { Providers } from "../lib/providers"

export const metadata: Metadata = {
  title: "GuestPost Portal",
  description: "Customer portal for managing guest post campaigns.",
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await connection()
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
