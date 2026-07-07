import type * as React from "react"

export interface AuthCardProps {
  title: string
  description?: string
  footer?: React.ReactNode
  children: React.ReactNode
}

export function AuthCard({
  title,
  description,
  footer,
  children,
}: AuthCardProps) {
  return (
    <div className="rounded-xl border border-[#23252a] bg-[#0f1011] p-8">
      <div className="mb-8 text-center">
        <h1 className="text-2xl font-semibold tracking-tight text-[#f7f8f8]">
          {title}
        </h1>
        {description && (
          <p className="mt-2 text-sm text-[#8a8f98]">{description}</p>
        )}
      </div>
      {children}
      {footer && (
        <div className="mt-8 border-t border-[#23252a] pt-6 text-center text-sm text-[#8a8f98]">
          {footer}
        </div>
      )}
    </div>
  )
}
