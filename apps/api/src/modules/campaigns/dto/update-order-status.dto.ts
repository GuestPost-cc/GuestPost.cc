import { IsString } from "class-validator"

export class UpdateOrderStatusDto {
  @IsString()
  status: string
}
