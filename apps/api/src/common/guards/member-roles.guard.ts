import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { CurrentAuthorityService } from "../../modules/auth/current-authority.service"
import { MEMBER_ROLES_KEY } from "../decorators/member-roles.decorator"

@Injectable()
export class MemberRolesGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorities: CurrentAuthorityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      MEMBER_ROLES_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!requiredRoles) return true

    const request = context.switchToHttp().getRequest()
    const user = request.user

    if (!user) {
      throw new ForbiddenException("Authentication required")
    }

    const authority = await this.authorities.resolveRequest(request)
    const userRole =
      authority.userType === "CUSTOMER"
        ? authority.customerRole
        : authority.userType === "PUBLISHER"
          ? authority.publisherRole
          : null

    if (!userRole) {
      throw new ForbiddenException("You are not a member of any organization")
    }

    if (!requiredRoles.includes(userRole)) {
      throw new ForbiddenException("Insufficient organization role")
    }

    return true
  }
}
