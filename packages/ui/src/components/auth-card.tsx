import type * as React from "react"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./card"

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
    <Card className="mx-auto w-full sm:w-[400px]">
      <CardHeader className="text-center">
        <CardTitle>{title}</CardTitle>
        {description && <CardDescription>{description}</CardDescription>}
      </CardHeader>
      <CardContent>{children}</CardContent>
      {footer && (
        <div className="pb-6 text-center text-sm text-muted-foreground">
          {footer}
        </div>
      )}
    </Card>
  )
}
