import { SetMetadata } from "@nestjs/common"

export const ORDER_OWNERSHIP_KEY = "orderOwnership"
export const RequireOrderOwnership = () =>
  SetMetadata(ORDER_OWNERSHIP_KEY, true)
