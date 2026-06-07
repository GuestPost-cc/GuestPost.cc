import { SetMetadata } from "@nestjs/common"
import type { StaffRole } from "@guestpost/shared"

export const STAFF_ROLES_KEY = "staffRoles"
export const StaffRoles = (...roles: StaffRole[]) => SetMetadata(STAFF_ROLES_KEY, roles)
