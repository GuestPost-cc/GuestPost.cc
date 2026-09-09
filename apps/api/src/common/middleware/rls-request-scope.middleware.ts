import { runWithRlsRequestScope } from "@guestpost/database"
import { Injectable, type NestMiddleware } from "@nestjs/common"
import type { NextFunction, Request, Response } from "express"

/** Initializes the per-request RLS context slot before global guards run. */
@Injectable()
export class RlsRequestScopeMiddleware implements NestMiddleware {
  use(_req: Request, _res: Response, next: NextFunction): void {
    runWithRlsRequestScope(next)
  }
}
