import { Module } from "@nestjs/common"
import { AuditModule } from "../audit/audit.module"
import { QueueModule } from "../queues/queue.module"
import { SettlementsController } from "./settlements.controller"
import { SettlementsService } from "./settlements.service"

// Phase 7.3 (audit #10) — SettlementAutoApproveService was deleted; the
// sweep now runs as a single BullMQ repeatable job in apps/worker
// (apps/worker/src/processors/settlement-auto-approve.processor.ts). One
// worker, one cron, cluster-wide dedup via jobId. No more N timers across
// N API pods.
@Module({
  imports: [AuditModule, QueueModule],
  controllers: [SettlementsController],
  providers: [SettlementsService],
  exports: [SettlementsService],
})
export class SettlementsModule {}
