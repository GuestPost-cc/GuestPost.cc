import { Type } from "class-transformer"
import { IsString, IsOptional, IsNumber, IsBoolean, IsArray, IsEnum, IsUrl, Min, Max, MinLength, MaxLength } from "class-validator"
import { ListingType, ListingStatus } from "@guestpost/database"
import { WebsiteOwnershipType } from "@guestpost/shared"

export class SearchListingsDto {
  @IsOptional()
  @IsString()
  query?: string

  @IsOptional()
  @IsString()
  category?: string

  @IsOptional()
  @IsString()
  type?: ListingType

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[]

  @IsOptional()
  @IsString()
  country?: string

  @IsOptional()
  @IsString()
  language?: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  minDR?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxDR?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minTraffic?: number

  @IsOptional()
  @IsString()
  sortBy?: "recommended" | "dr" | "traffic" | "price_asc" | "price_desc" | "newest" | "popular" | "best_rated" | "most_ordered"

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxTurnaroundDays?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  page?: number = 1

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(50)
  limit?: number = 20

  @IsOptional()
  @IsString()
  ownershipType?: WebsiteOwnershipType
}

export class CreateListingDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string

  @IsString()
  @MaxLength(1000)
  description!: string

  @IsOptional()
  @IsString()
  @MaxLength(500)
  shortDescription?: string

  @IsEnum(ListingType)
  type!: ListingType

  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus = ListingStatus.DRAFT

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price!: number

  @IsOptional()
  @IsString()
  currency?: string = "USD"

  @IsOptional()
  @IsString()
  priceType?: string = "fixed"

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  domainRating?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  domainAuthority?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  traffic?: number

  @IsOptional()
  @IsString()
  country?: string

  @IsOptional()
  @IsString()
  language?: string

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  countries?: string[]

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  languages?: string[]

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  turnaroundDays?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  revisionRounds?: number

  @IsOptional()
  @IsBoolean()
  featured?: boolean

  @IsOptional()
  @IsBoolean()
  verified?: boolean

  @IsOptional()
  @IsBoolean()
  allowGuestPost?: boolean

  @IsOptional()
  @IsBoolean()
  allowNicheEdit?: boolean

  @IsOptional()
  @IsBoolean()
  doFollowOnly?: boolean

  @IsOptional()
  @IsUrl()
  websiteUrl?: string

  @IsOptional()
  @IsUrl()
  sampleUrl?: string

  @IsOptional()
  @IsString()
  categoryId?: string

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[]

  @IsOptional()
  @IsString()
  publisherId?: string

  @IsOptional()
  @IsString()
  websiteId?: string
}

export class UpdateListingDto extends CreateListingDto {
  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus
}

export class CreateReviewDto {
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(5)
  rating!: number

  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  content!: string

  @IsString()
  listingId!: string
}

export class CreateFavoriteDto {
  @IsString()
  listingId!: string
}

export class CreateSavedListDto {
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string

  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string

  @IsOptional()
  @IsBoolean()
  isPublic?: boolean
}

export class AddToSavedListDto {
  @IsString()
  listingId!: string

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string
}

export class GetListingFiltersDto {
  @IsOptional()
  @IsString()
  category?: string

  @IsOptional()
  @IsEnum(ListingType)
  type?: ListingType

  @IsOptional()
  @IsString()
  country?: string

  @IsOptional()
  @IsString()
  language?: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minPrice?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  maxPrice?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(100)
  minDR?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  maxDR?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  minTraffic?: number

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[]

  @IsOptional()
  @IsString()
  publisherId?: string
}

export class GetRecommendationsDto {
  @IsOptional()
  @IsString()
  listingId?: string

  @IsOptional()
  @IsString()
  type?: "similar" | "recommended" | "frequently_bought" | "trending"

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(20)
  limit?: number = 10
}