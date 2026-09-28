import { cn } from "@guestpost/ui"
import type { Metadata } from "next"
import { headers } from "next/headers"
import { connection } from "next/server"
import "@guestpost/ui/styles.css"
import { AuthProvider } from "../lib/auth"
import { Providers } from "../lib/providers"

export const metadata: Metadata = {
  title: "GuestPost Admin",
  description: "Administration panel for GuestPost platform.",
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  await connection()
  const nonce = (await headers()).get("x-nonce") ?? undefined
  return (
    <html lang="en" suppressHydrationWarning>
      <body className={cn("min-h-screen bg-background font-sans antialiased")}>
        <AuthProvider>
          <Providers nonce={nonce}>{children}</Providers>
        </AuthProvider>
      </body>
    </html>
  )
}
