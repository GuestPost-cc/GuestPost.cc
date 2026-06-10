import { SetMetadata } from "@nestjs/common"
import type { UserType } from "@guestpost/shared"

export const ACTOR_TYPE_KEY = "actorType"
export const ActorType = (...types: UserType[]) => SetMetadata(ACTOR_TYPE_KEY, types)
