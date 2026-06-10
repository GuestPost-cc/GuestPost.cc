import { Module } from "@nestjs/common"
import { SettlementsController } from "./settlements.controller"
import { SettlementsService } from "./settlements.service"
import { SettlementAutoApproveService } from "./settlement-auto-approve.service"
import { AuditModule } from "../audit/audit.module"
import { QueueModule } from "../queues/queue.module"

@Module({
  imports: [AuditModule, QueueModule],
  controllers: [SettlementsController],
  providers: [SettlementsService, SettlementAutoApproveService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
