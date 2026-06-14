import { Module } from "@nestjs/common"
import { MarketplaceController } from "./marketplace.controller"
import { MarketplaceService } from "./marketplace.service"
import { QueueModule } from "../queues/queue.module"

@Module({
  imports: [QueueModule],
  controllers: [MarketplaceController],
  providers: [MarketplaceService],
  exports: [MarketplaceService],
})
export class MarketplaceModule {}