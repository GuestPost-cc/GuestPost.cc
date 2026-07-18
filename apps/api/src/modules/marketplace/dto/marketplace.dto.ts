import {
  ListingLinkType,
  ListingLinkValidity,
  ListingStatus,
  ServiceType,
} from "@guestpost/database"
import {
  MARKETPLACE_CATEGORY_LIMIT,
  MARKETPLACE_LANGUAGES,
  WebsiteOwnershipType,
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
  IsObject,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator"

// Public-facing availability values must mirror the Prisma enum without
// importing it as a type at runtime (Prisma re-exports it as a union).
export const SERVICE_AVAILABILITY_VALUES = [
  "AVAILABLE",
  "PAUSED",
  "WAITLIST",
] as const
export type ServiceAvailability = (typeof SERVICE_AVAILABILITY_VALUES)[number]

const queryArray = (value: unknown) =>
  Array.isArray(value) ? value : value == null ? value : [value]

// One service offering on a listing. The same listing can carry many.
// Price + turnaround are snapshotted onto the Order at creation, so
// edits here never alter an in-flight contract.
export class ListingServiceInput {
  @IsEnum(ServiceType)
  serviceType!: ServiceType

  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price!: number

  @IsOptional()
  @IsString()
  currency?: string = "USD"

  @Type(() => Number)
  @IsNumber()
  @Min(1)
  turnaroundDays!: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  revisionRounds?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  warrantyDays?: number

  @IsOptional()
  @IsObject()
  requirements?: Record<string, unknown>

  @IsOptional()
  @IsObject()
  fulfillmentSettings?: Record<string, unknown>

  @IsOptional()
  @IsEnum(SERVICE_AVAILABILITY_VALUES)
  availability?: ServiceAvailability
}

// Per-service PATCH — all fields optional; serviceType cannot be reassigned
// after creation (would orphan the unique (listingId, serviceType) constraint
// and any historical Order snapshot referring to a different intent).
export class UpdateListingServiceInput {
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number

  @IsOptional()
  @IsString()
  currency?: string

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  turnaroundDays?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  revisionRounds?: number

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  warrantyDays?: number

  @IsOptional()
  @IsObject()
  requirements?: Record<string, unknown>

  @IsOptional()
  @IsObject()
  fulfillmentSettings?: Record<string, unknown>

  @IsOptional()
  @IsEnum(SERVICE_AVAILABILITY_VALUES)
  availability?: ServiceAvailability

  // Optimistic-lock guard — caller must pass the version they last read.
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  version!: number
}

export class SearchListingsDto {
  @IsOptional()
  @IsString()
  query?: string

  @IsOptional()
  @IsString()
  category?: string

  @IsOptional()
  @Transform(({ value }) => queryArray(value))
  @IsArray()
  @ArrayUnique()
  @IsString({ each: true })
  categories?: string[]

  // Phase 7: SearchListingsDto.type was a ListingType filter; now it's a
  // ServiceType filter that matches listings with ≥1 AVAILABLE service of
  // the given type.
  @IsOptional()
  @IsString()
  type?: ServiceType

  @IsOptional()
  @Transform(({ value }) => queryArray(value))
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
  @Transform(({ value }) => queryArray(value))
  @IsArray()
  @ArrayUnique()
  @IsIn(MARKETPLACE_LANGUAGES, { each: true })
  languages?: string[]

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  sportsGamingAllowed?: boolean

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  pharmacyAllowed?: boolean

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  cryptoAllowed?: boolean

  @IsOptional()
  @Transform(({ value }) =>
    queryArray(value)?.map((item: unknown) => Number(item)),
  )
  @IsArray()
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  @Max(3, { each: true })
  backlinkCounts?: number[]

  @IsOptional()
  @Transform(({ value }) => queryArray(value))
  @IsArray()
  @ArrayUnique()
  @IsEnum(ListingLinkType, { each: true })
  linkTypes?: ListingLinkType[]

  @IsOptional()
  @Transform(({ value }) => queryArray(value))
  @IsArray()
  @ArrayUnique()
  @IsEnum(ListingLinkValidity, { each: true })
  linkValidities?: ListingLinkValidity[]

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  googleNews?: boolean

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  markedSponsored?: boolean

  @IsOptional()
  @Transform(({ value }) =>
    value === "true" ? true : value === "false" ? false : value,
  )
  @IsBoolean()
  foreignLanguageAllowed?: boolean

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
  sortBy?:
    | "recommended"
    | "dr"
    | "traffic"
    | "price_asc"
    | "price_desc"
    | "newest"
    | "popular"
    | "best_rated"
    | "most_ordered"

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
  @MinLength(1)
  @MaxLength(500)
  description!: string

  @IsOptional()
  @IsString()
  @MaxLength(500)
  shortDescription?: string

  // Phase 7: listing-level `type` was dropped. We keep this optional input
  // for one release as a no-op (server ignores it) so legacy clients that
  // still send a top-level type don't get a 400. Will be removed entirely
  // next release.
  @IsOptional()
  @IsString()
  type?: string

  @IsOptional()
  @IsEnum(ListingStatus)
  status?: ListingStatus = ListingStatus.DRAFT

  // Phase 7: also optional; per-service prices live on `services[]`.
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(0)
  price?: number

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
  @IsString()
  country?: string

  @IsString()
  @IsIn(MARKETPLACE_LANGUAGES)
  language!: string

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

  // allowGuestPost / allowNicheEdit removed in Phase 5 cleanup — multi-service
  // listings encode this via the presence of a ListingService row for each
  // serviceType. doFollowOnly stays as a listing-level link policy flag.
  @IsOptional()
  @IsBoolean()
  doFollowOnly?: boolean

  @IsOptional()
  @IsUrl()
  websiteUrl?: string

  @IsOptional()
  @IsUrl()
  sampleUrl?: string

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MARKETPLACE_CATEGORY_LIMIT)
  @ArrayUnique()
  @IsString({ each: true })
  categoryIds!: string[]

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

  // New-shape multi-service input. When present, services[] is the source of
  // truth; the listing-level `type` / `price` / `turnaroundDays` are still
  // accepted for backward compatibility and used only when services[] is
  // omitted (Phase 2 shim — removed in Phase 4).
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ListingServiceInput)
  services?: ListingServiceInput[]
}

export class UpdateListingDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  title!: string

  @IsString()
  @MinLength(1)
  @MaxLength(500)
  description!: string

  @IsOptional()
  @IsString()
  @MaxLength(500)
  shortDescription?: string

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MARKETPLACE_CATEGORY_LIMIT)
  @ArrayUnique()
  @IsString({ each: true })
  categoryIds!: string[]

  @IsString()
  @IsIn(MARKETPLACE_LANGUAGES)
  language!: string

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

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[]

  @IsOptional()
  @IsBoolean()
  doFollowOnly?: boolean

  @IsOptional()
  @IsUrl()
  sampleUrl?: string
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

  // Phase 7.12 (#17): when set, creates a service-scoped favorite — the
  // existing WAITLIST fan-out logic in MarketplaceService.updateServiceOnListing
  // already fires for (listingId, serviceType) tuples; this DTO field wires
  // the missing entry point. When omitted, default whole-listing favorite
  // (serviceType: null) is preserved for back-compat.
  @IsOptional()
  @IsEnum(ServiceType)
  serviceType?: ServiceType
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

  // Phase 7: same migration as SearchListingsDto.type — ServiceType filter.
  @IsOptional()
  @IsString()
  type?: ServiceType

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
