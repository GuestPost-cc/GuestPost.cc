import { IsString, Matches, MaxLength, MinLength } from "class-validator"

export class CreateOrganizationDto {
  @IsString()
  @MinLength(3)
  @MaxLength(200)
  name: string

  @IsString()
  @MaxLength(200)
  @Matches(/^[a-z0-9-]+$/)
  slug: string
}
