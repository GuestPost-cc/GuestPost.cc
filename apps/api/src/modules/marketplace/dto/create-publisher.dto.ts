import {
  IsEmail,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from "class-validator"

export class CreatePublisherDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string

  @IsEmail()
  @IsOptional()
  @MaxLength(254)
  email?: string
}
