import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { STAFF_ROLES_KEY } from "../decorators/staff-roles.decorator"
import type { StaffRole } from "@guestpost/shared"

@Injectable()
export class StaffRolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<StaffRole[]>(STAFF_ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!requiredRoles) return true

    const user = context.switchToHttp().getRequest().user

    if (!user || user.userType !== "STAFF") {
      throw new ForbiddenException("Only staff can access this resource")
    }

    if (!user.staffRole) {
      throw new ForbiddenException("No staff role assigned")
    }

    if (!requiredRoles.includes(user.staffRole)) {
      throw new ForbiddenException("Insufficient staff permissions")
    }

    return true
  }
}
