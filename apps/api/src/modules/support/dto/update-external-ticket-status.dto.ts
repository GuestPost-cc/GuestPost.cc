import { IsIn } from "class-validator"

export class UpdateExternalTicketStatusDto {
  @IsIn(["OPEN", "CLOSED"])
  status!: "OPEN" | "CLOSED"
}
