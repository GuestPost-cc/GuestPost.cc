import { runReconciliation } from "@guestpost/shared"
import { Injectable } from "@nestjs/common"
import { PrismaService } from "../../common/prisma.service"

/**
 * Financial drift detector. The check logic lives in
 * @guestpost/shared/reconciliation-core so the worker's scheduled sweep and
 * this on-demand endpoint can never disagree about what "drift" means.
 */
@Injectable()
export class ReconciliationService {
  constructor(private readonly prisma: PrismaService) {}

  async run() {
    return runReconciliation(this.prisma)
  }
}
