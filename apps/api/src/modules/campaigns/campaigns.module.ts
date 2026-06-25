import { Module } from "@nestjs/common"
import { OrdersModule } from "../orders/orders.module"
import { CampaignsController } from "./campaigns.controller"
import { CampaignsService } from "./campaigns.service"

@Module({
  imports: [OrdersModule],
  controllers: [CampaignsController],
  providers: [CampaignsService],
  exports: [CampaignsService],
})
export class CampaignsModule {}
