import { Module } from "@nestjs/common"
import { SupportController } from "./support.controller"
import { SupportService } from "./support.service"
import { QueueModule } from "../queues/queue.module"
import { AuditModule } from "../audit/audit.module"

@Module({
  imports: [QueueModule, AuditModule],
  controllers: [SupportController],
  providers: [SupportService],
  exports: [SupportService],
})
export class SupportModule {}
