import { SetMetadata } from "@nestjs/common"

export const MEMBER_ROLES_KEY = "memberRoles"
export const MemberRoles = (...roles: string[]) => SetMetadata(MEMBER_ROLES_KEY, roles)
