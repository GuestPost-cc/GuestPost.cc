import { StaffRole } from "@guestpost/shared"
import { SetMetadata } from "@nestjs/common"

export const STAFF_ROLES_KEY = "staffRoles"
export const StaffRoles = (...roles: StaffRole[]) =>
  SetMetadata(STAFF_ROLES_KEY, roles)
