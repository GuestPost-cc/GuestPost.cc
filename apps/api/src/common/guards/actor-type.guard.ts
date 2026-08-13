import { UserType } from "@guestpost/shared"
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { CurrentAuthorityService } from "../../modules/auth/current-authority.service"
import { ACTOR_TYPE_KEY } from "../decorators/actor-type.decorator"

@Injectable()
export class ActorTypeGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorities: CurrentAuthorityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requiredTypes = this.reflector.getAllAndOverride<UserType[]>(
      ACTOR_TYPE_KEY,
      [context.getHandler(), context.getClass()],
    )
    if (!requiredTypes) return true

    const request = context.switchToHttp().getRequest()
    const { user } = request
    if (!user) {
      throw new ForbiddenException("Authentication required")
    }

    const authority = await this.authorities.resolveRequest(request)
    if (!requiredTypes.includes(authority.userType)) {
      throw new ForbiddenException(
        `This action requires ${requiredTypes.join(" or ")} role. Current type: ${authority.userType}`,
      )
    }

    return true
  }
}
