import { Transform } from "class-transformer"
import { IsNotEmpty, IsString, MaxLength, MinLength } from "class-validator"

export class SettlementReasonDto {
  @IsString()
  @Transform(({ value }) => (typeof value === "string" ? value.trim() : value))
  @IsNotEmpty()
  @MinLength(1)
  @MaxLength(1000)
  reason!: string
}
