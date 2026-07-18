import { Module } from "@nestjs/common"
import { PermissionsGuard } from "../../common/guards/permissions.guard"
import { MarketplaceModule } from "../marketplace/marketplace.module"
import { OrdersModule } from "../orders/orders.module"
import { PublisherPayoutsModule } from "../publisher-payouts/publisher-payouts.module"
import { SettlementsModule } from "../settlements/settlements.module"
import { SupportModule } from "../support/support.module"
import { AdminController } from "./admin.controller"
import { AdminService } from "./admin.service"
import { CommandCenterService } from "./command-center.service"
import { RevenueService } from "./finance/revenue.service"
import { FinanceWorkbenchService } from "./finance-workbench.service"
import { OperationsWorkbenchService } from "./operations-workbench.service"
import { ReconciliationService } from "./reconciliation.service"
import { AdminVerificationQueueService } from "./verification-queue.service"
import { WebsiteVerificationService } from "./website-verification.service"

@Module({
  imports: [
    SettlementsModule,
    PublisherPayoutsModule,
    OrdersModule,
    MarketplaceModule,
    SupportModule,
  ],
  controllers: [AdminController],
  providers: [
    AdminService,
    CommandCenterService,
    FinanceWorkbenchService,
    OperationsWorkbenchService,
    AdminVerificationQueueService,
    ReconciliationService,
    RevenueService,
    WebsiteVerificationService,
    PermissionsGuard,
  ],
})
export class AdminModule {}
