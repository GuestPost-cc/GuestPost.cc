import { Module } from "@nestjs/common";
import { PrismaModule } from "./common/prisma.module";
import { AuthModule } from "./modules/auth/auth.module";
import { ActiveContextModule } from "./modules/active-context/active-context.module";
import { IdentityModule } from "./modules/identity/identity.module";
import { MarketplaceModule } from "./modules/marketplace/marketplace.module";
import { CampaignsModule } from "./modules/campaigns/campaigns.module";
import { BillingModule } from "./modules/billing/billing.module";
import { ReportingModule } from "./modules/reporting/reporting.module";
import { SupportModule } from "./modules/support/support.module";
import { QueueModule } from "./modules/queues/queue.module";
import { AdminModule } from "./modules/admin/admin.module";
import { AuditModule } from "./modules/audit/audit.module";
import { OrdersModule } from "./modules/orders/orders.module";
import { SettlementsModule } from "./modules/settlements/settlements.module";
import { PublisherPayoutsModule } from "./modules/publisher-payouts/publisher-payouts.module";
import { ApiKeysModule } from "./modules/api-keys/api-keys.module";
import { WebsitesModule } from "./modules/websites/websites.module";

@Module({
  imports: [
    PrismaModule,
    AuditModule,
    ActiveContextModule,
    AuthModule,
    QueueModule,
    IdentityModule,
    MarketplaceModule,
    CampaignsModule,
    BillingModule,
    ReportingModule,
    SupportModule,
    AdminModule,
    OrdersModule,
    SettlementsModule,
    PublisherPayoutsModule,
    ApiKeysModule,
    WebsitesModule,
  ],
})
export class AppModule {}
