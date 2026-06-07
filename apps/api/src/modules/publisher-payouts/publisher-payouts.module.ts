import { Module } from "@nestjs/common"
import { PublisherPayoutsController } from "./publisher-payouts.controller"
import { PublisherPayoutsService } from "./publisher-payouts.service"
import { AuditModule } from "../audit/audit.module"
import { QueueModule } from "../queues/queue.module"

@Module({
  imports: [AuditModule, QueueModule],
  controllers: [PublisherPayoutsController],
  providers: [PublisherPayoutsService],
  exports: [PublisherPayoutsService],
})
export class PublisherPayoutsModule {}
