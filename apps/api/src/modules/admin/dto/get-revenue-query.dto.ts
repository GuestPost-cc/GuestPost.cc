// Phase 7.1 — Query DTO for GET /admin/finance/revenue.
//
// Global ValidationPipe (forbidNonWhitelisted: true) rejects unknown keys; the
// enum guards on groupBy/format prevent typo-driven 500s and arbitrary values
// reaching the Prisma layer.
//
// Date strings are ISO YYYY-MM-DD or full ISO 8601 — class-validator's
// @IsDateString accepts both. Service layer parses with `new Date(...)` and
// rejects NaN in case of edge inputs (`@IsDateString` doesn't catch
// "2026-13-99" → still parses to a date object).

import { IsIn, IsISO8601, IsOptional } from "class-validator"

export const REVENUE_GROUP_BY_VALUES = [
  "channel",
  "month",
  "serviceType",
  "listing",
] as const
export type RevenueGroupBy = (typeof REVENUE_GROUP_BY_VALUES)[number]

export const REVENUE_FORMAT_VALUES = ["json", "csv"] as const
export type RevenueFormat = (typeof REVENUE_FORMAT_VALUES)[number]

export class GetRevenueQueryDto {
  @IsOptional()
  @IsISO8601()
  from?: string

  @IsOptional()
  @IsISO8601()
  to?: string

  @IsIn(REVENUE_GROUP_BY_VALUES as unknown as string[])
  groupBy!: RevenueGroupBy

  @IsOptional()
  @IsIn(REVENUE_FORMAT_VALUES as unknown as string[])
  format?: RevenueFormat
}
