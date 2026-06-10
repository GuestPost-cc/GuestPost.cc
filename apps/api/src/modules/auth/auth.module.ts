import { Global, Module } from "@nestjs/common"
import { APP_GUARD } from "@nestjs/core"
import { AuthGuard } from "./auth.guard"
import { ActiveContextModule } from "../active-context/active-context.module"

@Global()
@Module({
  imports: [ActiveContextModule],
  providers: [
    {
      provide: APP_GUARD,
      useClass: AuthGuard,
    },
  ],
  exports: [],
})
export class AuthModule {}
