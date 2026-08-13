import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { CurrentAuthorityService } from "../../modules/auth/current-authority.service"
import { PERMISSIONS_KEY } from "../decorators/permissions.decorator"

// Permissions that must be explicitly granted on the StaffMembership — never
// implied by any role, including SUPER_ADMIN. Insider-threat boundary: a
// compromised or curious admin account cannot read raw banking details unless
// someone deliberately granted it.
export const SENSITIVE_PERMISSIONS = ["FINANCIAL_DATA_DECRYPT"]

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorities: CurrentAuthorityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!requiredPermissions || requiredPermissions.length === 0) return true

    const request = context.switchToHttp().getRequest()
    const user = request.user
    if (!user) throw new ForbiddenException("No authenticated user")
    const authority = await this.authorities.resolveRequest(request)
    if (authority.userType !== "STAFF" || !authority.staffRole) {
      throw new ForbiddenException("No staff membership")
    }

    const sensitiveRequired = requiredPermissions.filter((p) =>
      SENSITIVE_PERMISSIONS.includes(p),
    )
    if (authority.staffRole === "SUPER_ADMIN" && sensitiveRequired.length === 0)
      return true
    const toCheck =
      authority.staffRole === "SUPER_ADMIN"
        ? sensitiveRequired
        : requiredPermissions
    const hasAll = toCheck.every((permission) =>
      authority.staffPermissions.includes(permission),
    )
    if (!hasAll)
      throw new ForbiddenException(
        `Missing required permission: ${toCheck.join(", ")}`,
      )
    return true
  }
}
