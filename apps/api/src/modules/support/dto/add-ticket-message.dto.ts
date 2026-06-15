import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from "class-validator"

// Phase 6.6: visibility scope for a ticket reply.
//   PUBLIC   — customer-visible message (default). Default participants are
//              notified per the channel-aware fan-out matrix.
//   INTERNAL — staff-only note. Invisible to the ticket's customer and to
//              publisher members; used as the escape valve for FINANCE
//              (read-only on PLATFORM tickets) + Admin + assigned Ops to
//              coordinate without writing to the customer-facing thread.
export enum TicketMessageVisibility {
  PUBLIC = "PUBLIC",
  INTERNAL = "INTERNAL",
}

export class AddTicketMessageDto {
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
