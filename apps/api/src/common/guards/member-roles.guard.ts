import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import type { Reflector } from "@nestjs/core"
import { MEMBER_ROLES_KEY } from "../decorators/member-roles.decorator"

@Injectable()
export class MemberRolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      MEMBER_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!requiredRoles) return true

    const user = context.switchToHttp().getRequest().user

    if (!user) {
      throw new ForbiddenException("Authentication required")
    }

    let userRole: string | null = null
    if (user.userType === "CUSTOMER") {
      userRole = user.customerRole
    } else if (user.userType === "PUBLISHER") {
      userRole = user.publisherRole
    } else if (user.userType === "STAFF") {
      userRole = user.staffRole
    }

    if (!userRole) {
      throw new ForbiddenException("You are not a member of any organization")
    }

    if (!requiredRoles.includes(userRole)) {
      throw new ForbiddenException("Insufficient organization role")
    }

    return true
  }
}
