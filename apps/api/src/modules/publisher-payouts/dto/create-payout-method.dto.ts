import { Type } from "class-transformer"
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator"

export const LEGACY_PAYOUT_METHOD_TYPES = [
  "bank_transfer",
  "paypal",
  "wise",
] as const

export class PayoutMethodDetailsDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  bankName?: string

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  accountHolderName?: string

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(64)
  accountNumber?: string

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  routingNumber?: string

  @IsOptional()
  @IsString()
  @MinLength(4)
  @MaxLength(34)
  iban?: string

  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9]{8}(?:[A-Za-z0-9]{3})?$/)
  swift?: string

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  email?: string

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  recipientId?: string

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  targetCurrency?: string
}

export class CreatePayoutMethodDto {
  @IsString()
  @IsIn(LEGACY_PAYOUT_METHOD_TYPES)
  type!: string

  @IsString()
  @MinLength(2)
  @MaxLength(100)
  label!: string

  @IsObject()
  @ValidateNested()
  @Type(() => PayoutMethodDetailsDto)
  details!: PayoutMethodDetailsDto

  @IsOptional()
  @IsBoolean()
  isDefault?: boolean
}
