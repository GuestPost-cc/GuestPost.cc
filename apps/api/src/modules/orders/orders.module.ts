import { Module } from "@nestjs/common"
import { OrdersController } from "./orders.controller"
import { OrdersService } from "./orders.service"
import { BillingModule } from "../billing/billing.module"
import { QueueModule } from "../queues/queue.module"

@Module({
  imports: [BillingModule, QueueModule],
  controllers: [OrdersController],
  providers: [OrdersService],
  exports: [OrdersService],
})
export class OrdersModule {}
