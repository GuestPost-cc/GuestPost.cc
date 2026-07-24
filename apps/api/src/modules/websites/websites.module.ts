import { Module } from "@nestjs/common"
import { AuditModule } from "../audit/audit.module"
import { WebsiteMetricsService } from "./website-metrics.service"
import { WebsitesController } from "./websites.controller"
import { WebsitesService } from "./websites.service"

@Module({
  imports: [AuditModule],
  controllers: [WebsitesController],
  providers: [WebsitesService, WebsiteMetricsService],
  exports: [WebsitesService, WebsiteMetricsService],
})
export class WebsitesModule {}
