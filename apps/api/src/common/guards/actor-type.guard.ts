import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { ACTOR_TYPE_KEY } from "../decorators/actor-type.decorator"
import type { UserType } from "@guestpost/shared"

@Injectable()
export class ActorTypeGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const requiredTypes = this.reflector.getAllAndOverride<UserType[]>(ACTOR_TYPE_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (!requiredTypes) return true

    const { user } = context.switchToHttp().getRequest()
    if (!user) {
      throw new ForbiddenException("Authentication required")
    }

    if (!requiredTypes.includes(user.userType)) {
      throw new ForbiddenException(
        `This action requires ${requiredTypes.join(" or ")} role. Current type: ${user.userType}`,
      )
    }

    return true
  }
}
