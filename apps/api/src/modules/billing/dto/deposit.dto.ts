import {
  IsNumber,
  IsPositive,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator"

export class DepositDto {
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  @Min(1)
  @Max(1000000)
  amount: number

  @IsString()
  @MaxLength(191)
  @Matches(/^[A-Za-z0-9._:-]+$/)
  idempotencyKey!: string
}
