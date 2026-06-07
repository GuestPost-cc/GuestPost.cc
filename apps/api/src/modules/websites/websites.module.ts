import { Module } from "@nestjs/common"
import { WebsitesController } from "./websites.controller"
import { WebsitesService } from "./websites.service"
import { AuditModule } from "../audit/audit.module"

@Module({
  imports: [AuditModule],
  controllers: [WebsitesController],
  providers: [WebsitesService],
  exports: [WebsitesService],
})
export class WebsitesModule {}
