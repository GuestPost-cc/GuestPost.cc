import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { PERMISSIONS_KEY } from "../decorators/permissions.decorator"
import { PrismaService } from "../prisma.service"

// Permissions that must be explicitly granted on the StaffMembership — never
// implied by any role, including SUPER_ADMIN. Insider-threat boundary: a
// compromised or curious admin account cannot read raw banking details unless
// someone deliberately granted it.
export const SENSITIVE_PERMISSIONS = ["FINANCIAL_DATA_DECRYPT"]

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredPermissions = this.reflector.getAllAndOverride<string[]>(
      PERMISSIONS_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!requiredPermissions || requiredPermissions.length === 0) return true

    const user = context.switchToHttp().getRequest().user
    if (!user) throw new ForbiddenException("No authenticated user")

    const sensitiveRequired = requiredPermissions.filter((p) =>
      SENSITIVE_PERMISSIONS.includes(p),
    )
    if (user.staffRole === "SUPER_ADMIN" && sensitiveRequired.length === 0)
      return true

    const membership = await this.prisma.staffMembership.findUnique({
      where: { userId: user.id },
      select: { permissions: true },
    })
    if (!membership) throw new ForbiddenException("No staff membership")

    const userPermissions: string[] = (membership.permissions as string[]) ?? []
    const toCheck =
      user.staffRole === "SUPER_ADMIN" ? sensitiveRequired : requiredPermissions
    const hasAll = toCheck.every((p) => userPermissions.includes(p))
    if (!hasAll)
      throw new ForbiddenException(
        `Missing required permission: ${toCheck.join(", ")}`,
      )
    return true
  }
}
