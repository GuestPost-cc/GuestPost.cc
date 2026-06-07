import { IsEmail, IsEnum } from "class-validator"

export enum CustomerRoleEnum {
  OWNER = "OWNER",
  MEMBER = "MEMBER",
}

export class InviteMemberDto {
  @IsEmail()
  email: string

  @IsEnum(CustomerRoleEnum)
  role: CustomerRoleEnum
}
