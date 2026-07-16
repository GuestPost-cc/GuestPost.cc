import { IS_PUBLIC_KEY } from "../../../common/decorators/public.decorator"
import { MarketplaceController } from "../marketplace.controller"

describe("MarketplaceController authentication coverage", () => {
  const discoveryHandlers = [
    "searchListings",
    "getListing",
    "getListingServices",
    "getCategories",
    "getTags",
    "getServices",
    "searchPublishers",
    "getStats",
  ] as const

  it.each(
    discoveryHandlers,
  )("keeps %s behind the global auth guard", (name) => {
    const handler = MarketplaceController.prototype[name]

    expect(Reflect.getMetadata(IS_PUBLIC_KEY, handler)).not.toBe(true)
  })
})
