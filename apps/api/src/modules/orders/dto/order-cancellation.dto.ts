import {
  CancellationReasonCode,
  CancellationResolution,
  CancellationResponsibility,
} from "@guestpost/database"
import { Transform, Type } from "class-transformer"
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator"

export class PublisherCompensationDecisionDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MaxLength(32)
  @Matches(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/, {
    message:
      "Publisher compensation must be a non-negative decimal string with at most two decimal places",
  })
  amount!: string

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(20, {
    message: "Publisher compensation reason must be at least 20 characters",
  })
  @MaxLength(2000)
  reason!: string
}

export class CancelOrderDto {
  @IsEnum(CancellationReasonCode)
  reasonCode: CancellationReasonCode

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  note?: string

  @IsInt()
  @Min(0)
  expectedVersion: number

  @IsString()
  @IsOptional()
  @MaxLength(200)
  idempotencyKey?: string
}

export class CreateCancellationRequestDto extends CancelOrderDto {}

export enum CancellationResponseAction {
  ACCEPT = "ACCEPT",
  CONTEST = "CONTEST",
}

export class RespondCancellationRequestDto {
  @IsEnum(CancellationResponseAction)
  action: CancellationResponseAction

  @IsString()
  @IsOptional()
  @MaxLength(2000)
  note?: string
}

export class ReviewCancellationRequestDto {
  @IsEnum(CancellationResolution)
  resolution: CancellationResolution

  @IsEnum(CancellationResponsibility)
  responsibility: CancellationResponsibility

  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(20, {
    message: "Cancellation review reason must be at least 20 characters",
  })
  @MaxLength(2000)
  reason: string
}

export class FinanceApproveCancellationDto {
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsString()
  @MinLength(20)
  @MaxLength(2000)
  reason: string

  // Required for post-publication publisher orders unless responsibility is
  // PUBLISHER. The service re-evaluates applicability and the maximum from
  // locked order/settlement evidence; this DTO only validates shape.
  @IsOptional()
  @ValidateNested()
  @Type(() => PublisherCompensationDecisionDto)
  publisherCompensation?: PublisherCompensationDecisionDto
}

export class ForceCancelOrderDto extends CancelOrderDto {
  @IsString()
  confirmationOrderId: string

  @IsEnum(CancellationResponsibility)
  responsibility: CancellationResponsibility

  // Required by the service for post-publication publisher orders unless the
  // publisher is responsible. The lifecycle/state check belongs inside the
  // locked transaction, so DTO validation cannot decide conditionally here.
  @IsOptional()
  @ValidateNested()
  @Type(() => PublisherCompensationDecisionDto)
  publisherCompensation?: PublisherCompensationDecisionDto
}
