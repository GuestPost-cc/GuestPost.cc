import { ServiceType } from "@guestpost/database"
import {
  IsEnum,
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  MaxLength,
} from "class-validator"

export class CreateOrderDto {
  @IsEnum(ServiceType)
  type: ServiceType

  @IsString()
  @IsOptional()
  @MaxLength(200)
  title?: string

  @IsString()
  @IsOptional()
  @MaxLength(5000)
  instructions?: string

  @IsUrl()
  @IsOptional()
  @MaxLength(2048)
  targetUrl?: string

  @IsString()
  @IsOptional()
  @MaxLength(200)
  anchorText?: string

  @IsString()
  @IsOptional()
  websiteId?: string

  @IsString()
  @IsOptional()
  campaignId?: string

  @IsString()
  @IsOptional()
  @MaxLength(200)
  idempotencyKey?: string

  @IsString()
  @IsOptional()
  listingServiceId?: string

  @IsObject()
  @IsOptional()
  briefData?: Record<string, unknown>

  @IsOptional()
  expectedListingServiceVersion?: unknown

  @IsOptional()
  expectedPrice?: unknown

  @IsOptional()
  expectedCurrency?: unknown
}
