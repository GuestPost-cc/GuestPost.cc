import "reflect-metadata"
import { plainToInstance } from "class-transformer"
import { validate } from "class-validator"
import {
  ListingServiceInput,
  UpdateListingServiceInput,
} from "../dto/marketplace.dto"
import { MarketplaceService } from "../marketplace.service"

describe("marketplace USD price validation", () => {
  it.each([
    0, -1, 10.001,
  ])("rejects invalid create DTO price %s", async (price) => {
    const dto = plainToInstance(ListingServiceInput, {
      serviceType: "GUEST_POST",
      price,
      currency: "USD",
      turnaroundDays: 3,
    })
    expect(await validate(dto)).not.toHaveLength(0)
  })

  it.each([
    0, -1, 10.001,
  ])("rejects invalid update DTO price %s", async (price) => {
    const dto = plainToInstance(UpdateListingServiceInput, {
      price,
      version: 1,
    })
    expect(await validate(dto)).not.toHaveLength(0)
  })

  it("accepts the smallest exact USD price", async () => {
    const dto = plainToInstance(ListingServiceInput, {
      serviceType: "GUEST_POST",
      price: 0.01,
      currency: "USD",
      turnaroundDays: 3,
    })
    expect(await validate(dto)).toHaveLength(0)
  })

  it.each([
    "EUR",
    "GBP",
    "usd",
    " USD",
  ])("rejects non-canonical create currency %s", async (currency) => {
    const dto = plainToInstance(ListingServiceInput, {
      serviceType: "GUEST_POST",
      price: 10,
      currency,
      turnaroundDays: 3,
    })
    expect(await validate(dto)).not.toHaveLength(0)
  })

  it.each([
    "EUR",
    "GBP",
    "usd",
    "USD ",
  ])("rejects non-canonical update currency %s", async (currency) => {
    const dto = plainToInstance(UpdateListingServiceInput, {
      currency,
      version: 1,
    })
    expect(await validate(dto)).not.toHaveLength(0)
  })

  it.each([
    0, 10.001,
  ])("service boundary rejects direct invalid price %s", async (price) => {
    const prisma = {
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue({
          id: "listing-1",
          publisherId: null,
          organizationId: "org-1",
          ownerType: "PLATFORM",
          websiteId: "website-1",
          currency: "USD",
        }),
      },
      listingService: { create: jest.fn() },
    }
    const service = new MarketplaceService(prisma as any, {} as any)

    await expect(
      service.addServiceToListing(
        {
          userId: "admin-1",
          isStaff: true,
          staffRole: "SUPER_ADMIN",
        },
        "listing-1",
        {
          serviceType: "GUEST_POST" as any,
          price,
          currency: "USD",
          turnaroundDays: 3,
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "INVALID_USD_PRICE" }),
    })
    expect(prisma.listingService.create).not.toHaveBeenCalled()
  })

  it("service boundary rejects a direct non-USD service write", async () => {
    const prisma = {
      marketplaceListing: {
        findUnique: jest.fn().mockResolvedValue({
          id: "listing-1",
          publisherId: null,
          organizationId: "org-1",
          ownerType: "PLATFORM",
          websiteId: "website-1",
          currency: "USD",
        }),
      },
      listingService: { create: jest.fn() },
    }
    const service = new MarketplaceService(prisma as any, {} as any)

    await expect(
      service.addServiceToListing(
        {
          userId: "admin-1",
          isStaff: true,
          staffRole: "SUPER_ADMIN",
        },
        "listing-1",
        {
          serviceType: "GUEST_POST" as any,
          price: 10,
          currency: "EUR",
          turnaroundDays: 3,
        },
      ),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: "UNSUPPORTED_CURRENCY" }),
    })
    expect(prisma.listingService.create).not.toHaveBeenCalled()
  })
})
