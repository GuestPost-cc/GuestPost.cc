import { Module } from "@nestjs/common"
import { OrdersController } from "./orders.controller"
import { OrdersService } from "./orders.service"
import { OrderPaymentService } from "./services/order-payment.service"
import { OrderFulfillmentService } from "./services/order-fulfillment.service"
import { OrderReviewService } from "./services/order-review.service"
import { OrderDisputeService } from "./services/order-dispute.service"
import { RefundService } from "./services/refund.service"
import { BillingModule } from "../billing/billing.module"
import { QueueModule } from "../queues/queue.module"
import { AuditModule } from "../audit/audit.module"

@Module({
  imports: [BillingModule, QueueModule, AuditModule],
  controllers: [OrdersController],
  providers: [
    OrdersService,
    OrderPaymentService,
    OrderFulfillmentService,
    OrderReviewService,
    OrderDisputeService,
    RefundService,
  ],
  exports: [OrdersService, OrderDisputeService, RefundService],
})
export class OrdersModule {}
