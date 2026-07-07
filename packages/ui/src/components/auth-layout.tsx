import type * as React from "react"

export interface AuthLayoutProps {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="dark min-h-screen bg-[#010102] flex flex-col items-center justify-center px-4">
      <div className="mb-8 flex items-center gap-2">
        <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-[#5e6ad2] text-white">
          <span className="text-sm font-bold">GP</span>
        </div>
        <span className="text-lg font-semibold tracking-tight text-[#f7f8f8]">
          GuestPost
        </span>
      </div>
      <div className="w-full max-w-sm">{children}</div>
    </div>
  )
}
