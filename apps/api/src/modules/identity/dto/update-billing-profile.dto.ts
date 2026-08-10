import { Transform } from "class-transformer"
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from "class-validator"

const trim = ({ value }: { value: unknown }) =>
  typeof value === "string" ? value.trim() : value
const optionalTrim = ({ value }: { value: unknown }) =>
  typeof value === "string" && value.trim() === "" ? null : trim({ value })
// PDF invoices embed a deterministic built-in Latin font. Reject unsupported
// glyphs at the settings boundary instead of corrupting a legal name later.
const SAFE_TEXT = /^[\u0020-\u007e\u00a0-\u00ff]+$/

export class UpdateBillingProfileDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(SAFE_TEXT)
  legalName: string

  @Transform(optionalTrim)
  @IsOptional()
  @IsEmail()
  @MaxLength(320)
  billingEmail?: string | null

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(160)
  @Matches(SAFE_TEXT)
  addressLine1: string

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(160)
  @Matches(SAFE_TEXT)
  addressLine2?: string | null

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(SAFE_TEXT)
  city: string

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(100)
  @Matches(SAFE_TEXT)
  region?: string | null

  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  @Matches(SAFE_TEXT)
  postalCode: string

  @Transform(({ value }) =>
    typeof value === "string" ? value.trim().toUpperCase() : value,
  )
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  countryCode: string

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(32)
  @Matches(/^[A-Za-z0-9 ._/-]+$/)
  taxIdType?: string | null

  @Transform(optionalTrim)
  @IsOptional()
  @IsString()
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9 ._/-]+$/)
  @ValidateIf((dto: UpdateBillingProfileDto) => Boolean(dto.taxIdType))
  taxId?: string | null
}
