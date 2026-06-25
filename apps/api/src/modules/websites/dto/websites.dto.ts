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
}

export class UpdateWebsiteDto extends CreateWebsiteDto {}
