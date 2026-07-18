import { ListingLinkType, ListingLinkValidity } from "@guestpost/database"
import {
  MARKETPLACE_CATEGORY_LIMIT,
  MARKETPLACE_LANGUAGES,
} from "@guestpost/shared"
import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
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
  @IsIn(MARKETPLACE_LANGUAGES)
  @MaxLength(50)
  language!: string

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MARKETPLACE_CATEGORY_LIMIT)
  @ArrayUnique()
  @IsString({ each: true })
  categoryIds!: string[]

  @IsString()
  @MaxLength(200)
  listingTitle!: string

  @IsString()
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
