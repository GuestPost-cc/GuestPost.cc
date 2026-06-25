import { Module } from "@nestjs/common"
import { QueueModule } from "../queues/queue.module"
import { MarketplaceController } from "./marketplace.controller"
import { MarketplaceService } from "./marketplace.service"

@Module({
  imports: [QueueModule],
  controllers: [MarketplaceController],
  providers: [MarketplaceService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}
