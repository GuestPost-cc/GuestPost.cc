import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
} from "@nestjs/common"
import { Reflector } from "@nestjs/core"
import { IS_PUBLIC_KEY } from "../../common/decorators/public.decorator"
import { CurrentAuthorityService } from "./current-authority.service"
import { requiresEmailVerification } from "./email-verification-policy"

@Injectable()
export class CurrentAuthorityGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly authorities: CurrentAuthorityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ])
    if (isPublic) return true

    const request = context.switchToHttp().getRequest()
    // AuthGuard is registered immediately before this guard and binds this ID
    // to the verified session. Requiring it here prevents accidental use of
    // the durable resolver as an authentication mechanism.
    if (!request.authenticatedUserId) {
      throw new ForbiddenException("Authenticated session authority required")
    }
    const authority = await this.authorities.resolveRequest(request)

    if (!authority.emailVerified && requiresEmailVerification(request)) {
      throw new ForbiddenException("EMAIL_NOT_VERIFIED")
    }

    // Keep the cached object for non-authoritative presentation fields, but
    // overwrite every field that can grant tenant, actor, role or permission
    // access. Explicit nulls remove stale grants after deletion/demotion.
    request.user = {
      ...request.user,
      ...authority,
      staffPermissions: [...authority.staffPermissions],
    }
    request.currentAuthority = authority
    return true
  }
}
