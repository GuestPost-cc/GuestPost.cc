import { IsString, IsOptional, IsEnum, IsUrl, MaxLength } from "class-validator"
import { ServiceType } from "@guestpost/database"

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
  @MaxLength(100)
  idempotencyKey?: string
}
