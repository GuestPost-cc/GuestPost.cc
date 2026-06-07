import { IsString, IsOptional } from "class-validator"

export class TransitionOrderDto {
  @IsString()
  status: string

  @IsOptional()
  metadata?: Record<string, unknown>
}
