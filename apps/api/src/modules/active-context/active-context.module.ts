import { Global, Module } from "@nestjs/common"
import { ActiveContextService } from "./active-context.service"

@Global()
@Module({
  providers: [ActiveContextService],
  exports: [ActiveContextService],
})
export class ActiveContextModule {}
