import { Module } from "@nestjs/common"
import { SettlementsController } from "./settlements.controller"
import { SettlementsService } from "./settlements.service"
import { AuditModule } from "../audit/audit.module"
import { QueueModule } from "../queues/queue.module"

@Module({
  imports: [AuditModule, QueueModule],
  controllers: [SettlementsController],
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
