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
  @ValidateIf((object) => object.assignedToUserId !== null)
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9_-]+$/iu, {
    message: "assignedToUserId must be a valid identifier",
  })
  assignedToUserId!: string | null

  @IsDefined()
  @ValidateIf((object) => object.expectedAssignedToUserId !== null)
  @IsString()
  @MaxLength(100)
  @Matches(/^[a-z0-9_-]+$/iu, {
    message: "expectedAssignedToUserId must be a valid identifier",
  })
  expectedAssignedToUserId!: string | null

  @IsString()
  @MinLength(10)
  @MaxLength(2_000)
  reason!: string
}
