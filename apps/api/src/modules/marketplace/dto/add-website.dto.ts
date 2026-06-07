import { IsString, IsUrl, IsOptional, MaxLength } from "class-validator"

export class AddWebsiteDto {
  @IsUrl()
  @MaxLength(2048)
  url: string

  @IsString()
  @IsOptional()
  @MaxLength(200)
  name?: string

  @IsString()
  @IsOptional()
  @MaxLength(100)
  category?: string

  @IsString()
  @IsOptional()
  @MaxLength(50)
  language?: string

  @IsString()
  @IsOptional()
  @MaxLength(100)
  country?: string

  @IsString()
  publisherId: string
}
