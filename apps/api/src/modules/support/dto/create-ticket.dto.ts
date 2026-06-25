import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator"

// Phase 6.7 — Audit finding V-1 closure.
//
// Customer-initiated ticket creation. The previous inline body type
// (`@Body() body: { subject: string; description?: string; orderId?: string }`)
// did no length validation; the global ValidationPipe's `forbidNonWhitelisted`
// + `transform` only strips unknown keys when a DTO class is present.
//
// Channel snapshot + assignee resolution happens server-side in
// SupportService.createTicket; the client only provides the user-facing
// fields here.
export class CreateTicketDto {
  @IsString()
  @MinLength(3, { message: "Subject must be at least 3 characters" })
  @MaxLength(200)
  subject!: string

  @IsOptional()
  @IsString()
  @MaxLength(10_000)
  description?: string

  // CUID format for order references. Bounds the string + format so a junk
  // orderId can't reach the service layer's order lookup with weird content.
  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z0-9]+$/i, { message: "orderId must be a valid identifier" })
  orderId?: string
}
