import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Choose a new password",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
  },
}

export default function ResetPasswordLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
