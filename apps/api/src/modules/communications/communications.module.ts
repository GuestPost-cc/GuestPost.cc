import { Global, Module } from "@nestjs/common"
import { CommunicationsService } from "./communications.service"

@Global()
@Module({
  providers: [CommunicationsService],
  exports: [CommunicationsService],
})
export class CommunicationsModule {}
