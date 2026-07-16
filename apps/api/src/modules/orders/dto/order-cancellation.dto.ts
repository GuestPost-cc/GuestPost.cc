import {
  CancellationReasonCode,
  CancellationResolution,
  CancellationResponsibility,
} from "@guestpost/database"
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  Min,
} from "class-validator"

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
}
