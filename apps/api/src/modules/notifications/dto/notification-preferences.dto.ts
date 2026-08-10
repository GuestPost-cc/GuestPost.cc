import { Type } from "class-transformer"
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEnum,
  ValidateNested,
} from "class-validator"

export enum NotificationPreferenceCategoryDto {
  SECURITY = "SECURITY",
  ACCOUNT = "ACCOUNT",
  ORDERS = "ORDERS",
  BILLING = "BILLING",
  SETTLEMENTS = "SETTLEMENTS",
  PAYOUTS = "PAYOUTS",
  MARKETPLACE = "MARKETPLACE",
  SUPPORT = "SUPPORT",
  STAFF_ALERTS = "STAFF_ALERTS",
  PRODUCT = "PRODUCT",
}

export class NotificationPreferenceUpdateDto {
  @IsEnum(NotificationPreferenceCategoryDto)
  category!: NotificationPreferenceCategoryDto

  @IsBoolean()
  inApp!: boolean

  @IsBoolean()
  email!: boolean
}

export class UpdateNotificationPreferencesDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(10)
  @ArrayUnique((item: NotificationPreferenceUpdateDto) => item.category)
  @ValidateNested({ each: true })
  @Type(() => NotificationPreferenceUpdateDto)
  preferences!: NotificationPreferenceUpdateDto[]
}
