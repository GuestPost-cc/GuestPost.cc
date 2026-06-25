import { IsOptional, IsString, MaxLength } from "class-validator"

export class AddOrderItemDto {
  @IsString()
  @IsOptional()
  websiteId?: string

  @IsString()
  @IsOptional()
  @MaxLength(2048)
  targetUrl?: string

  @IsString()
  @IsOptional()
  @MaxLength(200)
  anchorText?: string
}
