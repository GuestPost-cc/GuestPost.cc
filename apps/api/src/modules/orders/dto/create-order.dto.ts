import { IsString, IsOptional, IsEnum, IsArray, IsObject, ValidateNested, MaxLength } from "class-validator"
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

  // Phase 2: the customer's locked pick from the listing detail page.
  // Optional in Phase 2 (legacy clients without it still work via the
  // (websiteId, type) fallback) → required in Phase 4.
  @IsString()
  @IsOptional()
  listingServiceId?: string

  // Phase 6: structured per-service brief. Validated server-side against
  // the @guestpost/shared brief Zod registry. Shape varies by ServiceType
  // (e.g. LOCAL_CITATION carries an address object; NICHE_EDIT requires
  // existingArticleUrl). class-validator can't introspect Zod, so we
  // accept any object here and let the service layer Zod-parse it.
  @IsObject()
  @IsOptional()
  briefData?: Record<string, unknown>

  @IsArray()
  @IsOptional()
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items?: OrderItemDto[]
}
