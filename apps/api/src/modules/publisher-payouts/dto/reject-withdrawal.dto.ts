import { IsString, MaxLength, MinLength } from "class-validator"

export class RejectWithdrawalDto {
  @IsString()
  @MinLength(10)
  @MaxLength(2_000)
  reason!: string
}
