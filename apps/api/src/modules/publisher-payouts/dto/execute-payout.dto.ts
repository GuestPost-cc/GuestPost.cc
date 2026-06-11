import { IsString, IsIn, IsOptional, IsNumber, IsPositive } from "class-validator"

export class ExecutePayoutDto {
  @IsString()
  @IsIn(["manual", "wise", "stripe_connect"])
  providerName: string
}

export class RetryExecutionDto {
  @IsString()
  executionId: string
}

export class WebhookPayoutDto {
  @IsString()
  provider: string

  @IsString()
  event: string

  data: Record<string, unknown>
}
