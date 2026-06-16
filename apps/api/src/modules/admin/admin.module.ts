import { Module } from "@nestjs/common"
import { AdminController } from "./admin.controller"
import { AdminService } from "./admin.service"
import { ReconciliationService } from "./reconciliation.service"
import { RevenueService } from "./finance/revenue.service"
import { WebsiteVerificationService } from "./website-verification.service"
import { PermissionsGuard } from "../../common/guards/permissions.guard"
import { SettlementsModule } from "../settlements/settlements.module"
import { PublisherPayoutsModule } from "../publisher-payouts/publisher-payouts.module"
import { OrdersModule } from "../orders/orders.module"
import { MarketplaceModule } from "../marketplace/marketplace.module"
import { SupportModule } from "../support/support.module"

@Module({
  imports: [SettlementsModule, PublisherPayoutsModule, OrdersModule, MarketplaceModule, SupportModule],
  controllers: [AdminController],
  providers: [AdminService, ReconciliationService, RevenueService, WebsiteVerificationService, PermissionsGuard],
})
export class AdminModule {}
