import { USD_CURRENCY } from "@guestpost/shared"
import { IsIn, IsInt, IsString, Matches, Max, Min } from "class-validator"

// Capture accepts the exact cart state the buyer reviewed. The amount stays a
// decimal string all the way through validation; coercing it to Number would
// discard evidence for sufficiently large values before the money layer sees
// it.
export class SubmitPaymentDto {
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  expectedVersion: number

  @IsString()
  @Matches(/^(?:0\.(?:0[1-9]|[1-9]\d)|[1-9]\d*\.\d{2})$/, {
    message: "expectedAmount must be a positive canonical USD amount",
  })
  expectedAmount: string

  @IsString()
  @IsIn([USD_CURRENCY])
  expectedCurrency: typeof USD_CURRENCY
}
