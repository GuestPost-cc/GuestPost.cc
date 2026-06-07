import { Module } from "@nestjs/common"
import { AdminController } from "./admin.controller"
import { AdminService } from "./admin.service"
import { SettlementsModule } from "../settlements/settlements.module"
import { PublisherPayoutsModule } from "../publisher-payouts/publisher-payouts.module"

@Module({
  imports: [SettlementsModule, PublisherPayoutsModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
