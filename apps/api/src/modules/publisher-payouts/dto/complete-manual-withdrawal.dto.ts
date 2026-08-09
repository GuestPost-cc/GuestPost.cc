import {
  IsISO8601,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator"

export class CompleteManualWithdrawalDto {
  @IsString()
  @MinLength(1)
  @MaxLength(191)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9_-]*$/)
  withdrawalPublicReference!: string

  @IsString()
  @MaxLength(191)
  @Matches(/^[A-Za-z0-9_-]+$/)
  executionId!: string

  @IsString()
  @MinLength(6)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9._:/ -]*$/)
  bankReference!: string

  @IsISO8601({ strict: true })
  paidAt!: string

  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  reason!: string
}
