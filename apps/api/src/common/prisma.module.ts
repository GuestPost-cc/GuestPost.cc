import { Global, Module } from "@nestjs/common"
import { PrismaService } from "./prisma.service"

@Global()
@Module({
  providers: [
    {
      provide: PrismaService,
      useFactory: () => new PrismaService().asRlsAwareClient(),
    },
  ],
  exports: [PrismaService],
})
export class PrismaModule {}
