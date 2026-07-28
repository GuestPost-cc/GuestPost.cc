import { cn } from "@guestpost/ui"
import type { Metadata } from "next"
import "@guestpost/ui/styles.css"
import { SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "../lib/site-config"
import "./website.css"

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: `${SITE_NAME} | Accountable guest-post placements`,
    template: `%s | ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  referrer: "strict-origin-when-cross-origin",
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  openGraph: {
    type: "website",
    locale: "en_US",
    url: SITE_URL,
    siteName: SITE_NAME,
    title: `${SITE_NAME} | Accountable guest-post placements`,
    description: SITE_DESCRIPTION,
    images: [
      {
        url: "/og.png",
        width: 1200,
        height: 630,
        alt: "GuestPost - Guest-post work that holds up to scrutiny.",
      },
    ],
  },
  twitter: {
    card: "summary_large_image",
    title: `${SITE_NAME} | Accountable guest-post placements`,
    description: SITE_DESCRIPTION,
    images: ["/og.png"],
  },
  manifest: "/manifest.webmanifest",
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en" data-scroll-behavior="smooth">
      <body className={cn("min-h-screen bg-background antialiased")}>
        {children}
      </body>
    </html>
  )
}
