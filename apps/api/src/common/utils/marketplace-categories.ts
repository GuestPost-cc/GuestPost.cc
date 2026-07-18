import {
  MARKETPLACE_CATEGORY_LIMIT,
  MARKETPLACE_LANGUAGES,
} from "@guestpost/shared"
import { BadRequestException } from "@nestjs/common"
import type { PrismaService } from "../prisma.service"

export async function requireActiveMarketplaceCategories(
  prisma: Pick<PrismaService, "marketplaceCategory">,
  categoryIds: readonly string[],
) {
  const uniqueIds = [...new Set(categoryIds)]
  if (
    uniqueIds.length < 1 ||
    uniqueIds.length > MARKETPLACE_CATEGORY_LIMIT ||
    uniqueIds.length !== categoryIds.length
  ) {
    throw new BadRequestException({
      code: "INVALID_MARKETPLACE_CATEGORIES",
      message: `Choose between 1 and ${MARKETPLACE_CATEGORY_LIMIT} unique marketplace categories`,
    })
  }

  const categories = await prisma.marketplaceCategory.findMany({
    where: { id: { in: uniqueIds }, isActive: true },
    select: { id: true, name: true, slug: true },
  })
  if (categories.length !== uniqueIds.length) {
    throw new BadRequestException({
      code: "INVALID_MARKETPLACE_CATEGORIES",
      message: "Select only active marketplace categories",
    })
  }

  const byId = new Map(categories.map((category) => [category.id, category]))
  return uniqueIds.map((id) => byId.get(id)!)
}

export function hasCompleteListingPolicy(listing: {
  sportsGamingAllowed: boolean | null
  pharmacyAllowed: boolean | null
  cryptoAllowed: boolean | null
  backlinkCount: number | null
  linkType: string | null
  linkValidity: string | null
  googleNews: boolean | null
  markedSponsored: boolean | null
  foreignLanguageAllowed: boolean | null
}) {
  return (
    listing.sportsGamingAllowed !== null &&
    listing.pharmacyAllowed !== null &&
    listing.cryptoAllowed !== null &&
    listing.backlinkCount !== null &&
    listing.linkType !== null &&
    listing.linkValidity !== null &&
    listing.googleNews !== null &&
    listing.markedSponsored !== null &&
    listing.foreignLanguageAllowed !== null
  )
}

export function isMarketplaceLanguage(
  value: string | null | undefined,
): boolean {
  return (
    typeof value === "string" &&
    (MARKETPLACE_LANGUAGES as readonly string[]).includes(value)
  )
}
