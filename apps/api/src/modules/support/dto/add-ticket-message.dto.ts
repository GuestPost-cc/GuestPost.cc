import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from "class-validator"

// Phase 6.6: visibility scope for a ticket reply.
//   PUBLIC   — customer-visible message (default). Default participants are
//              notified per the channel-aware fan-out matrix.
//   INTERNAL — staff-only note. Invisible to the ticket's customer and to
//              publisher members; used by Super Admin and assigned Operations
//              staff to coordinate without writing to the public thread.
export enum TicketMessageVisibility {
  PUBLIC = "PUBLIC",
  INTERNAL = "INTERNAL",
}

export class AddTicketMessageDto {
  @IsUUID("4")
  clientMessageId!: string

  // Bounded so an unauthenticated body parser bypass can't push a multi-MB
  // payload into the row. 10k chars is a generous ceiling for a single
  // support reply.
  @IsString()
  @MinLength(1, { message: "Message content is required" })
  @MaxLength(10_000, { message: "Message is too long" })
  content!: string

  @IsOptional()
  @IsEnum(TicketMessageVisibility)
  visibility?: TicketMessageVisibility
}
