import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  Max,
  Min,
} from "class-validator"

export class DepositDto {
  @IsNumber()
  @IsPositive()
  @Min(1)
  @Max(1000000)
  amount: number

  @IsString()
  @IsOptional()
  reference?: string
}
