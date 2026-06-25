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

  // Phase 6.5: optional explicit owner. Service validates the target user has
  // OPERATIONS staff role; omit to default to the creator (if they're OPS)
  // or NULL (if they're SUPER_ADMIN).
  @IsString()
  @IsOptional()
  @MaxLength(64)
  managedByUserId?: string
}

export class UpdatePlatformWebsiteDto extends CreatePlatformWebsiteDto {}
