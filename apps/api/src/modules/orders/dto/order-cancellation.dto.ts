import {
  CancellationReasonCode,
  CancellationResolution,
  CancellationResponsibility,
} from "@guestpost/database"
import { Transform, Type } from "class-transformer"
import {
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from "class-validator"

export class PublisherCompensationDecisionDto {
  @IsNumber(
    { allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 },
    {
      message:
        "Publisher compensation must be an exact amount with at most two decimal places",
    },
  )
  @Min(0)
  amount!: number

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

  @IsString()
  @MaxLength(2000)
  reason: string
}

export class FinanceApproveCancellationDto {
  @IsString()
  @MaxLength(2000)
  reason: string
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
