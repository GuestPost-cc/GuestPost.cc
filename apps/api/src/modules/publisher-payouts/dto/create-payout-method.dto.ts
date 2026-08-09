import { Type } from "class-transformer"
import {
  IsBoolean,
  IsIn,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from "class-validator"

export const LEGACY_PAYOUT_METHOD_TYPES = ["bank_transfer"] as const

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
