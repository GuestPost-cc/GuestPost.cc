import { IsString, MaxLength, MinLength } from "class-validator"

export class CreateTeamDto {
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string
}
