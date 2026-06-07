"use client"

import * as React from "react"
import { cn } from "../lib/utils"
import { Card, CardContent } from "./card"
import { TrendingDown, TrendingUp } from "lucide-react"

interface KpiCardProps {
  label: string
  value: string | number
  trend?: {
    value: number
    isPositive: boolean
  }
  className?: string
}

function KpiCard({ label, value, trend, className }: KpiCardProps) {
  return (
    <Card className={cn("", className)}>
      <CardContent className="p-6">
        <p className="text-sm font-medium text-muted-foreground">{label}</p>
        <div className="mt-2 flex items-end justify-between">
          <p className="text-3xl font-semibold tracking-tight">{value}</p>
          {trend && (
            <div
              className={cn(
                "flex items-center gap-1 text-sm font-medium",
                trend.isPositive ? "text-emerald-600" : "text-red-600"
              )}
            >
              {trend.isPositive ? (
                <TrendingUp className="h-4 w-4" />
              ) : (
                <TrendingDown className="h-4 w-4" />
              )}
              <span>{Math.abs(trend.value)}%</span>
            </div>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

export { KpiCard }