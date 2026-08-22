import type { ModerationCommand } from "../marketplace-moderation"
import { AdminService } from "../services/admin"
import { MarketplaceService } from "../services/marketplace"
import { PublishersService } from "../services/publishers"

describe("marketplace moderation client", () => {
  const command: ModerationCommand = {
    action: "REQUEST_CHANGES",
    reasonCode: "INCOMPLETE_LISTING",
    expectedVersion: 4,
    publisherMessage:
      "Please complete the placement policy before resubmitting.",
  }

  it("posts a versioned listing moderation command", async () => {
    const client = {
      post: jest.fn().mockResolvedValue({
        moderation: { active: null, version: 5, allowedActions: [] },
      }),
    }
    const service = new AdminService(client as any)

    await service.moderateListing("listing-1", command)

    expect(client.post).toHaveBeenCalledWith(
      "/admin/marketplace/listings/listing-1/moderate",
      { json: command },
    )
  })

  it("posts a versioned website moderation command", async () => {
    const client = {
      post: jest.fn().mockResolvedValue({
        moderation: { active: null, version: 5, allowedActions: [] },
      }),
    }
    const service = new AdminService(client as any)

    await service.moderateWebsite("website-1", command)

    expect(client.post).toHaveBeenCalledWith(
      "/admin/websites/website-1/moderate",
      { json: command },
    )
  })

  it("includes the listing projection version on publisher submission", async () => {
    const client = { post: jest.fn().mockResolvedValue({}) }
    const service = new PublishersService(client as any)

    await service.submitForReview("publisher-1", "website-1", 9)

    expect(client.post).toHaveBeenCalledWith(
      "/publishers/publisher-1/websites/website-1/submit",
      { json: { expectedVersion: 9 } },
    )
  })

  it.each([
    ["submitListing", "submit"],
    ["pauseListing", "pause"],
    ["unpauseListing", "unpause"],
    ["archiveListing", "archive"],
  ] as const)("includes the projection version for %s", async (method, route) => {
    const client = { post: jest.fn().mockResolvedValue({}) }
    const service = new MarketplaceService(client as any)

    await service[method]("listing-1", 11)

    expect(client.post).toHaveBeenCalledWith(
      `/marketplace/listings/listing-1/${route}`,
      { json: { expectedVersion: 11 } },
    )
  })

  it("uses the audited publisher website archive command", async () => {
    const client = { post: jest.fn().mockResolvedValue({}) }
    const service = new PublishersService(client as any)

    await service.archiveWebsite("publisher-1", "website-1", 6)

    expect(client.post).toHaveBeenCalledWith(
      "/publishers/publisher-1/websites/website-1/archive",
      { json: { expectedVersion: 6 } },
    )
  })

  it("uses the audited publisher website reopen command", async () => {
    const client = { post: jest.fn().mockResolvedValue({}) }
    const service = new PublishersService(client as any)

    await service.reopenWebsite("publisher-1", "website-1", 7)

    expect(client.post).toHaveBeenCalledWith(
      "/publishers/publisher-1/websites/website-1/reopen",
      { json: { expectedVersion: 7 } },
    )
  })
})
