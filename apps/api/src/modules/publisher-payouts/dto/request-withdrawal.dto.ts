import {
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator"

export class RequestWithdrawalDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(1)
  @Max(1_000_000)
  amount!: number

  @IsString()
  @MaxLength(32)
  @Matches(/^[a-z_]+$/)
  method!: string

  @IsString()
  @MaxLength(191)
  @Matches(/^[A-Za-z0-9_-]+$/)
  idempotencyKey!: string

  @IsOptional()
  @IsString()
  @MaxLength(191)
  @Matches(/^[A-Za-z0-9_-]+$/)
  payoutMethodId?: string
}
