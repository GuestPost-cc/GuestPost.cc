import { ServiceType } from "@guestpost/database"
import { Type } from "class-transformer"
import {
  IsEnum,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator"

export class CreateWebsiteServiceDto {
  @IsEnum(ServiceType)
  serviceType!: ServiceType

  @Type(() => Number)
  @IsNumber()
  @Min(0.01)
  price!: number

  @IsOptional()
  @IsString()
  @IsIn(["USD", "EUR", "GBP"])
  currency?: string = "USD"

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  turnaroundDays!: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  revisionRounds?: number = 2

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  warrantyDays?: number
}

export class CreateWebsiteDto {
  @IsString()
  @MaxLength(100)
  @IsOptional()
  name?: string

  @IsUrl()
  @MaxLength(2048)
  url!: string

  @IsString()
  @IsOptional()
  @MaxLength(100)
  country?: string

  @IsString()
  @IsOptional()
  @MaxLength(50)
  language?: string

  @IsString()
  @IsOptional()
  @MaxLength(100)
  category?: string

  @IsString()
  @IsOptional()
  @MaxLength(64)
  categoryId?: string

  @IsString()
  @IsOptional()
  @MinLength(3)
  @MaxLength(200)
  listingTitle?: string

  @IsString()
  @IsOptional()
  @MinLength(1)
  @MaxLength(500)
  description?: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  @Max(100)
  domainRating?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  monthlyTraffic?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  turnaroundDays?: number

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateWebsiteServiceDto)
  initialService?: CreateWebsiteServiceDto
}

export class UpdateWebsiteDto extends CreateWebsiteDto {}
