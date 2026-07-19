import {
  ListingLinkType,
  ListingLinkValidity,
  ServiceType,
} from "@guestpost/database"
import {
  MARKETPLACE_CATEGORY_LIMIT,
  MARKETPLACE_LANGUAGES,
} from "@guestpost/shared"
import { Transform, Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
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
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(100)
  @IsOptional()
  name?: string

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  @MaxLength(2048)
  url!: string

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsOptional()
  @MaxLength(100)
  country?: string

  @IsString()
  @IsIn(MARKETPLACE_LANGUAGES)
  @MaxLength(50)
  language!: string

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MARKETPLACE_CATEGORY_LIMIT)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  categoryIds!: string[]

  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @MinLength(3)
  @MaxLength(200)
  listingTitle!: string

  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @MinLength(20)
  @MaxLength(500)
  description!: string

  @IsOptional()
  @ValidateNested()
  @Type(() => CreateWebsiteServiceDto)
  initialService?: CreateWebsiteServiceDto

  @IsBoolean()
  sportsGamingAllowed!: boolean

  @IsBoolean()
  pharmacyAllowed!: boolean

  @IsBoolean()
  cryptoAllowed!: boolean

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  backlinkCount!: number

  @IsEnum(ListingLinkType)
  linkType!: ListingLinkType

  @IsEnum(ListingLinkValidity)
  linkValidity!: ListingLinkValidity

  @IsBoolean()
  googleNews!: boolean

  @IsBoolean()
  markedSponsored!: boolean

  @IsBoolean()
  foreignLanguageAllowed!: boolean
}

export class UpdateWebsiteDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string

  @IsOptional()
  @IsUrl()
  @MaxLength(2048)
  url?: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  country?: string

  @IsOptional()
  @IsString()
  @IsIn(MARKETPLACE_LANGUAGES)
  @MaxLength(50)
  language?: string
}
