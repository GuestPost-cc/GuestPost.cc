import { Module } from "@nestjs/common"
import { AdminController } from "./admin.controller"
import { AdminService } from "./admin.service"
import { ReconciliationService } from "./reconciliation.service"
import { WebsiteVerificationService } from "./website-verification.service"
import { PermissionsGuard } from "../../common/guards/permissions.guard"
import { SettlementsModule } from "../settlements/settlements.module"
import { PublisherPayoutsModule } from "../publisher-payouts/publisher-payouts.module"
import { OrdersModule } from "../orders/orders.module"
import { MarketplaceModule } from "../marketplace/marketplace.module"

@Module({
  imports: [SettlementsModule, PublisherPayoutsModule, OrdersModule, MarketplaceModule],
  controllers: [AdminController],
  providers: [AdminService, ReconciliationService, WebsiteVerificationService, PermissionsGuard],
})
export class AdminModule {}
