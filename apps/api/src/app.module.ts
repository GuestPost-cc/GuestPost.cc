import {
  type MiddlewareConsumer,
  Module,
  type NestModule,
} from "@nestjs/common"
import { RequestIdMiddleware } from "./common/middleware/request-id.middleware"
import { PrismaModule } from "./common/prisma.module"
import { ActiveContextModule } from "./modules/active-context/active-context.module"
import { AdminModule } from "./modules/admin/admin.module"
import { ApiKeysModule } from "./modules/api-keys/api-keys.module"
import { AuditModule } from "./modules/audit/audit.module"
import { AuthModule } from "./modules/auth/auth.module"
import { BillingModule } from "./modules/billing/billing.module"
import { CampaignsModule } from "./modules/campaigns/campaigns.module"
import { IdentityModule } from "./modules/identity/identity.module"
import { MarketplaceModule } from "./modules/marketplace/marketplace.module"
import { NotificationsModule } from "./modules/notifications/notifications.module"
import { OrdersModule } from "./modules/orders/orders.module"
import { PublisherPayoutsModule } from "./modules/publisher-payouts/publisher-payouts.module"
import { QueueModule } from "./modules/queues/queue.module"
import { ReportingModule } from "./modules/reporting/reporting.module"
import { SettlementsModule } from "./modules/settlements/settlements.module"
import { SupportModule } from "./modules/support/support.module"
import { WebsitesModule } from "./modules/websites/websites.module"

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
    NotificationsModule,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    // RequestIdMiddleware mounts before all routes — establishes the
    // AsyncLocalStorage frame that audit logs / Sentry tags / worker
    // enqueue all read from.
    consumer.apply(RequestIdMiddleware).forRoutes("*")
  }
}
