import { IsString, MinLength } from "class-validator"

export class DecryptPayoutMethodDto {
  @IsString()
  @MinLength(10)
  reason: string
}