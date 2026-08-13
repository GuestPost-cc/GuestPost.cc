import { Global, Module } from "@nestjs/common"
import { APP_GUARD } from "@nestjs/core"
import { ActorTypeGuard } from "../../common/guards/actor-type.guard"
import { MemberRolesGuard } from "../../common/guards/member-roles.guard"
import { OrderOwnershipGuard } from "../../common/guards/order-ownership.guard"
import { StaffRolesGuard } from "../../common/guards/staff-roles.guard"
import { ActiveContextModule } from "../active-context/active-context.module"
import { AuthGuard } from "./auth.guard"
import { CurrentAuthorityGuard } from "./current-authority.guard"
import { CurrentAuthorityService } from "./current-authority.service"

@Global()
@Module({
  imports: [ActiveContextModule],
  providers: [
    CurrentAuthorityService,
    ActorTypeGuard,
    MemberRolesGuard,
    StaffRolesGuard,
    OrderOwnershipGuard,
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
    {
      provide: APP_GUARD,
      useClass: CurrentAuthorityGuard,
    },
  ],
  exports: [
    CurrentAuthorityService,
    ActorTypeGuard,
    MemberRolesGuard,
    StaffRolesGuard,
    OrderOwnershipGuard,
  ],
})
export class AuthModule {}
