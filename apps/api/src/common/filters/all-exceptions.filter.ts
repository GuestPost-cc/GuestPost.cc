import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common"
import type { Response } from "express"

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()

    let status = HttpStatus.INTERNAL_SERVER_ERROR
    let message = "Internal server error"

    if (exception instanceof HttpException) {
      status = exception.getStatus()
      const res = exception.getResponse()
      message =
        typeof res === "string" ? res : ((res as any).message ?? message)
    }

    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.stack : exception,
      )
      message = "Internal server error"
    } else if (status === 429) {
      message = "Too many requests, try again later"
    } else {
      this.logger.warn(`HTTP ${status}: ${message}`)
    }

    response.status(status).json({ statusCode: status, message })
  }
}
