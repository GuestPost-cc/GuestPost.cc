import { Global, Module } from "@nestjs/common"
import { APP_GUARD } from "@nestjs/core"
import { ActiveContextModule } from "../active-context/active-context.module"
import { AuthGuard } from "./auth.guard"

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
