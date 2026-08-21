import { Type } from "class-transformer"
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator"

export class ListSupportTicketsQueryDto {
  @IsOptional()
  @IsIn(["OPEN", "IN_PROGRESS", "WAITING_ON_CUSTOMER", "RESOLVED", "CLOSED"])
  status?: string

  @IsOptional()
  @IsString()
  @MaxLength(50)
  @Matches(/^[a-z0-9_-]+$/iu, { message: "orderId is invalid" })
  orderId?: string

  @IsOptional()
  @IsString()
  @MaxLength(512)
  cursor?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number
}
