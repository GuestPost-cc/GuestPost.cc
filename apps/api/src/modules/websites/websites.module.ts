import { Module } from "@nestjs/common"
import { AuditModule } from "../audit/audit.module"
import { WebsitesController } from "./websites.controller"
import { WebsitesService } from "./websites.service"

@Module({
  imports: [AuditModule],
  controllers: [WebsitesController],
  providers: [WebsitesService],
  exports: [WebsitesService],
})
export class WebsitesModule {}
