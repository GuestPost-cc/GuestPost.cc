import { IsOptional, IsString, MaxLength, MinLength } from "class-validator"

export class CreateCampaignDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  name: string

  @IsString()
  @IsOptional()
  @MaxLength(5000)
  description?: string
}
