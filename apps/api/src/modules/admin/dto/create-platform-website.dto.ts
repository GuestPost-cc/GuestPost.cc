import { ListingLinkType, ListingLinkValidity } from "@guestpost/database"
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
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator"
import { ManualWebsiteMetricsDto } from "../../websites/dto/websites.dto"

export class CreatePlatformWebsiteDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsUrl({ protocols: ["http", "https"], require_protocol: true })
  @MaxLength(2048)
  url!: string

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @IsOptional()
  @MaxLength(100)
  name?: string

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

  @IsDefined()
  @ValidateNested()
  @Type(() => ManualWebsiteMetricsDto)
  manualMetrics!: ManualWebsiteMetricsDto

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
  @IsIn(MARKETPLACE_LANGUAGES)
  @MaxLength(50)
  language?: string

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MARKETPLACE_CATEGORY_LIMIT)
  @ArrayUnique()
  @IsString({ each: true })
  @IsOptional()
  categoryIds?: string[]

  @IsString()
  @IsOptional()
  @MaxLength(200)
  listingTitle?: string

  @IsString()
  @IsOptional()
  @MaxLength(500)
  description?: string

  @IsBoolean()
  @IsOptional()
  sportsGamingAllowed?: boolean

  @IsBoolean()
  @IsOptional()
  pharmacyAllowed?: boolean

  @IsBoolean()
  @IsOptional()
  cryptoAllowed?: boolean

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(3)
  @IsOptional()
  backlinkCount?: number

  @IsEnum(ListingLinkType)
  @IsOptional()
  linkType?: ListingLinkType

  @IsEnum(ListingLinkValidity)
  @IsOptional()
  linkValidity?: ListingLinkValidity

  @IsBoolean()
  @IsOptional()
  googleNews?: boolean

  @IsBoolean()
  @IsOptional()
  markedSponsored?: boolean

  @IsBoolean()
  @IsOptional()
  foreignLanguageAllowed?: boolean
}
