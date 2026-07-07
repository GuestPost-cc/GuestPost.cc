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
    <div className="rounded-lg border border-border bg-card p-6">
      <div className="mb-6 text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          {title}
        </h1>
        {description && (
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {children}
      {footer && (
        <div className="mt-6 border-t border-border pt-4 text-center text-sm text-muted-foreground">
          {footer}
        </div>
      )}
    </div>
  )
}
