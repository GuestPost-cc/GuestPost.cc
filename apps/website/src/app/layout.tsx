import type { Metadata } from "next"
import { cn } from "@guestpost/ui"
import "@guestpost/ui/styles.css"

const inter = "Inter"

export const metadata: Metadata = {
  title: "GuestPost — Premium SEO Authority Building",
  description: "Connect with high-authority publishers and build your SEO presence with data-driven guest posting campaigns.",
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={cn("min-h-screen bg-background font-sans antialiased")}>{children}</body>
    </html>
  )
}
