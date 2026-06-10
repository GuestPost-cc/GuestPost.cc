import { IsNumber, IsPositive, IsOptional, IsString, Max, Min } from "class-validator"

export class WithdrawDto {
  @IsNumber()
  @IsPositive()
  @Min(1)
  @Max(1000000)
  amount: number

  @IsString()
  @IsOptional()
  idempotencyKey?: string
}
