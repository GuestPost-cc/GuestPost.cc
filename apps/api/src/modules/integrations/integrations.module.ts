import { Module } from "@nestjs/common"
import { IntegrationsController } from "./integrations.controller"
import { IntegrationsService } from "./integrations.service"
import { OwnerResolver } from "./owner-resolver.service"

@Module({
  controllers: [IntegrationsController],
  providers: [IntegrationsService, OwnerResolver],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
