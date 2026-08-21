import { Type } from "class-transformer"
import { IsInt, Min } from "class-validator"

/** Client-visible optimistic concurrency fence for publisher commands. */
export class ModerationVersionDto {
  @Type(() => Number)
  @IsInt()
  @Min(0)
  expectedVersion!: number
}
