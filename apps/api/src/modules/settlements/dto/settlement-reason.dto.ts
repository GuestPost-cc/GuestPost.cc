import { IsNotEmpty, IsString, MaxLength } from "class-validator"

export class SettlementReasonDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string
}
