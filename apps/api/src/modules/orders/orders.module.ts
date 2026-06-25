import { Module } from "@nestjs/common"
import { AuditModule } from "../audit/audit.module"
import { BillingModule } from "../billing/billing.module"
import { QueueModule } from "../queues/queue.module"
import { DeliveriesController } from "./deliveries.controller"
import { OrdersController } from "./orders.controller"
import { OrdersService } from "./orders.service"
import { DeliveryInterventionService } from "./services/delivery-intervention.service"
import { OrderDeliveryService } from "./services/order-delivery.service"
import { OrderDisputeService } from "./services/order-dispute.service"
import { OrderFulfillmentService } from "./services/order-fulfillment.service"
import { OrderFulfillmentAssignmentService } from "./services/order-fulfillment-assignment.service"
import { OrderOperationsService } from "./services/order-operations.service"
import { OrderPaymentService } from "./services/order-payment.service"
import { OrderReviewService } from "./services/order-review.service"
import { RefundService } from "./services/refund.service"

@Module({
  imports: [BillingModule, QueueModule, AuditModule],
  controllers: [OrdersController, DeliveriesController],
  providers: [
    OrdersService,
    OrderPaymentService,
    OrderFulfillmentService,
    OrderReviewService,
    OrderDisputeService,
    OrderOperationsService,
    OrderDeliveryService,
    OrderFulfillmentAssignmentService,
    DeliveryInterventionService,
    RefundService,
  ],
  exports: [
    OrdersService,
    OrderDisputeService,
    RefundService,
    OrderOperationsService,
    OrderDeliveryService,
    OrderFulfillmentAssignmentService,
    OrderReviewService,
  ],
})
export class OrdersModule {}
