import { Module } from "@nestjs/common"
import { CampaignsController } from "./campaigns.controller"
import { CampaignsService } from "./campaigns.service"
import { OrdersModule } from "../orders/orders.module"

@Module({
  imports: [OrdersModule],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
