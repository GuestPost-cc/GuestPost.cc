import { IntegrationError } from "@guestpost/integrations"
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from "@nestjs/common"
import { Response } from "express"

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  private readonly logger = new Logger(AllExceptionsFilter.name)

  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp()
    const response = ctx.getResponse<Response>()

    let status = HttpStatus.INTERNAL_SERVER_ERROR
    let message = "Internal server error"
    let code: string | undefined

    if (exception instanceof IntegrationError) {
      status = this.statusForIntegrationError(exception)
      message = exception.message
      code = exception.code
    } else if (exception instanceof HttpException) {
      status = exception.getStatus()
      const res = exception.getResponse()
      message =
        typeof res === "string" ? res : ((res as any).message ?? message)
      code = typeof res === "string" ? undefined : (res as any).code
    }

    if (status >= 500) {
      this.logger.error(
        exception instanceof Error ? exception.stack : exception,
      )
      if (!this.canExposeServerError(exception)) {
        message = "Internal server error"
      }
    } else if (status === 429) {
      message = "Too many requests, try again later"
    } else {
      this.logger.warn(`HTTP ${status}: ${message}`)
    }

    response
      .status(status)
      .json({ statusCode: status, message, ...(code && { code }) })
  }

  private canExposeServerError(exception: unknown): boolean {
    return (
      exception instanceof IntegrationError &&
      exception.code === "PROVIDER_ERROR" &&
      (exception.details?.providerCode === "GOOGLE_OAUTH_CONFIG_MISSING" ||
        exception.details?.providerCode === "API_BASE_URL_MISSING")
    )
  }

  private statusForIntegrationError(error: IntegrationError): number {
    if (error.code === "INVALID_REQUEST") return HttpStatus.BAD_REQUEST
    if (error.code === "UNAUTHORIZED") return HttpStatus.UNAUTHORIZED
    if (error.code === "PERMISSION_DENIED") return HttpStatus.FORBIDDEN
    if (error.code.endsWith("_NOT_FOUND")) return HttpStatus.NOT_FOUND
    if (error.code === "RATE_LIMITED" || error.code === "PROVIDER_RATE_LIMIT") {
      return HttpStatus.TOO_MANY_REQUESTS
    }
    if (error.code === "TOKEN_EXPIRED" || error.code === "REAUTH_REQUIRED") {
      return HttpStatus.UNAUTHORIZED
    }
    if (
      error.code === "PROVIDER_ERROR" &&
      (error.details?.providerCode === "GOOGLE_OAUTH_CONFIG_MISSING" ||
        error.details?.providerCode === "API_BASE_URL_MISSING")
    ) {
      return HttpStatus.SERVICE_UNAVAILABLE
    }
    if (error.code === "PROVIDER_ERROR") return HttpStatus.BAD_GATEWAY
    return HttpStatus.BAD_REQUEST
  }
}
