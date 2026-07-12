import { Module } from "@nestjs/common"
import { IntegrationsController } from "./integrations.controller"
import { IntegrationsApiService } from "./integrations.service"
import { OwnerResolver } from "./owner-resolver.service"

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsApiService, OwnerResolver],
  exports: [IntegrationsApiService],
})
export class IntegrationsModule {}
