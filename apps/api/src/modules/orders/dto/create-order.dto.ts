import { IsString, IsOptional, IsEnum, IsArray, ValidateNested, MaxLength } from "class-validator"
import { Type } from "class-transformer"
import { ServiceType } from "@guestpost/database"

class OrderItemDto {
  @IsString()
  @IsOptional()
  websiteId?: string

  @IsString()
  @IsOptional()
  @MaxLength(2048)
  targetUrl?: string

  @IsString()
  @IsOptional()
  @MaxLength(200)
  anchorText?: string
}

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

  @IsString()
  @IsOptional()
  campaignId?: string

  @IsString()
  @IsOptional()
  idempotencyKey?: string

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[]
}
