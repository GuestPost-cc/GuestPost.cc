import { Module } from "@nestjs/common"
import { AuditModule } from "../audit/audit.module"
import { QueueModule } from "../queues/queue.module"
import { SupportController } from "./support.controller"
import { SupportService } from "./support.service"

@Module({
  imports: [QueueModule, AuditModule],
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
