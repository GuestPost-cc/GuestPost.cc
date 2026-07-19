import { Global, Module } from "@nestjs/common"
import { QueueService } from "./queue.service"
import { WorkerWakeupService } from "./worker-wakeup.service"

@Global()
@Module({
  providers: [QueueService, WorkerWakeupService],
  exports: [QueueService, WorkerWakeupService],
})
export class QueueModule {}
