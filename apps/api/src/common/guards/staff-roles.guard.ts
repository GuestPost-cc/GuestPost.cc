import { StaffRole } from "@guestpost/shared"
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { CurrentAuthorityService } from "../../modules/auth/current-authority.service"
import { STAFF_ROLES_KEY } from "../decorators/staff-roles.decorator"

// Phase 6.7 — Audit finding #2 remediation.
//
// Fail-closed behavior: a route that uses `@UseGuards(StaffRolesGuard)` but
// has no `@StaffRoles(...)` metadata is REFUSED, not allowed. The previous
// implementation returned `true` for missing metadata, which combined with
// the class-level @StaffRoles + getAllAndOverride pattern in AdminController
// silently widened access whenever a handler forgot its decorator.
//
// The contract is now explicit at the guard layer:
//   1. Guarded route MUST declare @StaffRoles(...) — class-level or handler-
//      level. Empty arrays are rejected too (an empty allowlist allows no
//      one but is almost certainly a mistake, not an intentional gate).
//   2. The authenticated user must be STAFF with a valid staffRole.
//   3. The staffRole must be in the route's allowlist.
//
// `apps/api/src/modules/admin/__tests__/admin-rbac-coverage.spec.ts` asserts
// that every AdminController handler declares its own @StaffRoles. Future
// PRs that add a route get caught at test time, not at runtime as a leak.
@Injectable()
export class StaffRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorities: CurrentAuthorityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<StaffRole[]>(
      STAFF_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    )

    // Fail-closed on missing or empty metadata.
    if (!requiredRoles || requiredRoles.length === 0) {
      throw new ForbiddenException(
        "Route is missing @StaffRoles authorization metadata — refused by fail-closed RBAC",
      )
    }

    const request = context.switchToHttp().getRequest()
    const user = request.user

    if (!user) {
      throw new ForbiddenException("Only staff can access this resource")
    }

    const authority = await this.authorities.resolveRequest(request)
    if (authority.userType !== "STAFF") {
      throw new ForbiddenException("Only staff can access this resource")
    }
    if (!authority.staffRole) {
      throw new ForbiddenException("No staff role assigned")
    }

    if (!requiredRoles.includes(authority.staffRole)) {
      throw new ForbiddenException("Insufficient staff permissions")
    }

    return true
  }
}
