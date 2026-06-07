import { Module } from "@nestjs/common"
import { SupportController } from "./support.controller"
import { SupportService } from "./support.service"
import { QueueModule } from "../queues/queue.module"

@Module({
  imports: [QueueModule],
  controllers: [SupportController],
  providers: [SupportService],
})
export class SupportModule {}
