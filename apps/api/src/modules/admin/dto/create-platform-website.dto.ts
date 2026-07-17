import { Type } from "class-transformer"
import {
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
} from "class-validator"

export class CreatePlatformWebsiteDto {
  @IsUrl()
  @MaxLength(2048)
  url!: string

  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string

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

  // Super Admin may optionally choose an Operations owner. For Operations
  // callers the service ignores this value and always assigns the creator.
  @IsString()
  @IsOptional()
  @MaxLength(64)
  managedByUserId?: string
}

export class UpdatePlatformWebsiteDto {
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string

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
}
