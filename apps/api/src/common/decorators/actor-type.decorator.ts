import { UserType } from "@guestpost/shared"
import { SetMetadata } from "@nestjs/common"

export const ACTOR_TYPE_KEY = "actorType"
export const ActorType = (...types: UserType[]) =>
  SetMetadata(ACTOR_TYPE_KEY, types)
