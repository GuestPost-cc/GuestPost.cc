import {
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from "class-validator"

export const DELIVERY_FRAUD_DISPOSITIONS = [
  "FALSE_POSITIVE",
  "AUTHORIZED_REUSE",
  "RISK_ACCEPTED",
] as const

export type DeliveryFraudDisposition =
  (typeof DELIVERY_FRAUD_DISPOSITIONS)[number]

export class DeliveryInterventionReasonDto {
  @IsString()
  @MinLength(20)
  @MaxLength(1_000)
  reason!: string
}

export class OverrideDeliveryVerificationDto extends DeliveryInterventionReasonDto {
  @IsString()
  @IsIn(["VERIFIED", "FAILED"])
  targetStatus!: "VERIFIED" | "FAILED"
}

export class ResolveDeliveryFraudFlagDto extends DeliveryInterventionReasonDto {
  @IsString()
  @IsIn(DELIVERY_FRAUD_DISPOSITIONS as unknown as string[])
  disposition!: DeliveryFraudDisposition

  @ValidateIf(
    (input: ResolveDeliveryFraudFlagDto) =>
      input.disposition !== "FALSE_POSITIVE" ||
      input.evidenceReference !== undefined,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  evidenceReference?: string
}

export class ConfirmDeliveryFraudFlagDto extends DeliveryInterventionReasonDto {
  @IsInt()
  @Min(0)
  expectedOrderVersion!: number

  @IsInt()
  @Min(0)
  expectedVerificationVersion!: number

  @IsUUID()
  idempotencyKey!: string
}
