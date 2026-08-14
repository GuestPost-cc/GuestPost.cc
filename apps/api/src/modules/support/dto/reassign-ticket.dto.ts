import {
  IsDefined,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from "class-validator"

export class ReassignTicketDto {
  @IsDefined()
  @ValidateIf((value) => value.assignedToUserId !== null)
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9_-]+$/iu, {
    message: "assignedToUserId must be a valid identifier",
  })
  assignedToUserId!: string | null

  @IsString()
  @MinLength(10)
  @MaxLength(2_000)
  reason!: string
}
