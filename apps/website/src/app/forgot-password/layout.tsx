import type { Metadata } from "next"

export const metadata: Metadata = {
  title: "Reset password",
  robots: {
    index: false,
    follow: false,
    noarchive: true,
  },
}

export default function ForgotPasswordLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return children
}
