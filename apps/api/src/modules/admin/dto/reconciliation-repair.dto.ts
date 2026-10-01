import { Transform } from "class-transformer"
import {
  IsBoolean,
  IsInt,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from "class-validator"

const DIGEST = /^[0-9a-f]{64}$/
const INCIDENT_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{1,191}$/

export class ProposeRefundCreditRepairDto {
  @IsBoolean()
  providerRefundConfirmedAbsent!: boolean

  @IsString()
  @Matches(DIGEST)
  evidenceDigest!: string

  @IsInt()
  @Min(0)
  expectedCaseVersion!: number

  @IsString()
  @MinLength(3)
  @MaxLength(191)
  @Matches(INCIDENT_REFERENCE)
  incidentReference!: string

  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @MinLength(20)
  @MaxLength(1000)
  @Matches(/^[^\u0000-\u001f\u007f]*$/)
  reason!: string
}

export class ApproveRefundCreditRepairDto {
  @IsString()
  @Matches(DIGEST)
  proposalDigest!: string
}

export class ExecuteRefundCreditRepairDto {
  @IsString()
  @Matches(DIGEST)
  proposalDigest!: string

  @IsString()
  @Matches(IDEMPOTENCY_KEY)
  idempotencyKey!: string
}
