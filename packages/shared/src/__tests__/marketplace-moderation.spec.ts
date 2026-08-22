import {
  buildModerationProjection,
  getPublisherListingLifecycleActions,
  getPublisherWebsiteLifecycleActions,
  getStaffListingModerationActions,
  getStaffWebsiteModerationActions,
  LEGACY_SUPER_ADMIN_LISTING_PAUSE_MESSAGE,
  LEGACY_SUPER_ADMIN_WEBSITE_PAUSE_MESSAGE,
  projectModerationPublisherMessage,
} from "../marketplace-moderation"

const superAdmin = { id: "super-1", staffRole: "SUPER_ADMIN" as const }
const operations = { id: "ops-1", staffRole: "OPERATIONS" as const }

describe("marketplace moderation policy", () => {
  it("scopes Operations to publisher inventory or assigned platform inventory", () => {
    const base = {
      status: "PENDING_REVIEW" as const,
      activeModerationAction: null,
      activeModerationAuthority: null,
      moderationVersion: 0,
    }
    expect(
      getStaffListingModerationActions(
        { ...base, ownerType: "PUBLISHER" },
        operations,
      ),
    ).toEqual(["APPROVE", "REQUEST_CHANGES"])
    expect(
      getStaffListingModerationActions(
        {
          ...base,
          ownerType: "PLATFORM",
          managedByUserId: "someone-else",
        },
        operations,
      ),
    ).toEqual([])
    expect(
      getStaffListingModerationActions(
        { ...base, ownerType: "PLATFORM", managedByUserId: "ops-1" },
        operations,
      ),
    ).toEqual(["APPROVE", "REQUEST_CHANGES"])
  })

  it("never lets a publisher resume or archive over a staff pause", () => {
    expect(
      getPublisherListingLifecycleActions({
        status: "PAUSED",
        ownerType: "PUBLISHER",
        activeModerationAction: "PAUSE",
        activeModerationAuthority: "OPERATIONS",
        activeModerationPreviousStatus: "APPROVED",
        moderationResubmissionAllowed: false,
      }),
    ).toEqual([])
  })

  it("allows only an explicitly permitted request-changes resubmission", () => {
    const rejected = {
      status: "REJECTED" as const,
      ownerType: "PUBLISHER" as const,
      activeModerationAction: "REQUEST_CHANGES" as const,
      activeModerationAuthority: "OPERATIONS" as const,
    }
    expect(
      getPublisherListingLifecycleActions({
        ...rejected,
        moderationResubmissionAllowed: false,
      }),
    ).toEqual([])
    expect(
      getPublisherListingLifecycleActions({
        ...rejected,
        moderationResubmissionAllowed: true,
      }),
    ).toEqual(["SUBMIT_FOR_REVIEW"])
  })

  it("keeps a staff archive closed until Super Admin explicitly allows resubmission", () => {
    const archived = {
      status: "ARCHIVED" as const,
      ownerType: "PUBLISHER" as const,
      activeModerationAction: "ARCHIVE" as const,
      activeModerationAuthority: "SUPER_ADMIN" as const,
    }
    expect(
      getPublisherListingLifecycleActions({
        ...archived,
        moderationResubmissionAllowed: false,
      }),
    ).toEqual([])
    expect(
      getPublisherListingLifecycleActions({
        ...archived,
        moderationResubmissionAllowed: true,
      }),
    ).toEqual(["SUBMIT_FOR_REVIEW"])
  })

  it("does not guess a restore target for legacy paused listings", () => {
    const listing = {
      status: "PAUSED" as const,
      ownerType: "PUBLISHER" as const,
      activeModerationAction: "PAUSE" as const,
      activeModerationAuthority: "SUPER_ADMIN" as const,
      activeModerationReasonCode: "LEGACY_ORIGIN_UNKNOWN" as const,
      activeModerationPreviousStatus: null,
      moderationResubmissionAllowed: false,
    }
    expect(getStaffListingModerationActions(listing, superAdmin)).toEqual([
      "ARCHIVE",
      "REOPEN",
    ])
  })

  it("keeps domain restore independent from listing lifecycle", () => {
    const website = {
      isActive: false,
      ownershipType: "PLATFORM" as const,
      managedByUserId: "ops-1",
      activeModerationAction: "PAUSE" as const,
      activeModerationAuthority: "OPERATIONS" as const,
      activeModerationReasonCode: "OPERATIONAL_HOLD" as const,
      activeModerationPreviousActive: true,
      moderationVersion: 3,
    }
    expect(getStaffWebsiteModerationActions(website, operations)).toEqual([
      "RESTORE",
    ])
    expect(
      buildModerationProjection(
        website,
        getStaffWebsiteModerationActions(website, operations),
      ),
    ).toMatchObject({
      version: 3,
      allowedActions: ["RESTORE"],
      active: {
        action: "PAUSE",
        authority: "OPERATIONS",
        previousWebsiteActive: true,
      },
    })
  })

  it("prevents a publisher from overwriting a staff website hold", () => {
    expect(
      getPublisherWebsiteLifecycleActions({
        isActive: false,
        ownershipType: "PUBLISHER",
        activeModerationAction: "PAUSE",
        activeModerationAuthority: "OPERATIONS",
      }),
    ).toEqual([])
  })

  it("makes Finance read-only even when lifecycle state is actionable", () => {
    expect(
      getStaffListingModerationActions(
        { status: "PENDING_REVIEW", ownerType: "PUBLISHER" },
        { id: "finance-1", staffRole: "FINANCE" },
      ),
    ).toEqual([])
  })

  const legacyListingEvent = {
    id: "legacy-listing-listing-1-paused",
    listingId: "listing-1",
    websiteId: null,
    scope: "LISTING",
    action: "PAUSE",
    authority: "SUPER_ADMIN",
    reasonCode: "LEGACY_ORIGIN_UNKNOWN",
    publisherMessage:
      "This listing was paused before moderation history was introduced. GuestPost Operations must review it before restoration.",
    actorUserId: null,
    actorStaffRole: null,
    previousStatus: null,
    resultingStatus: "PAUSED",
    previousWebsiteActive: null,
    resultingWebsiteActive: null,
    resubmissionAllowed: false,
  } as const
  const legacyWebsiteEvent = {
    id: "legacy-website-website-1-inactive",
    listingId: null,
    websiteId: "website-1",
    scope: "WEBSITE",
    action: "PAUSE",
    authority: "SUPER_ADMIN",
    reasonCode: "LEGACY_ORIGIN_UNKNOWN",
    publisherMessage:
      "This website was inactive before moderation history was introduced. GuestPost Operations must review it before restoration.",
    actorUserId: null,
    actorStaffRole: null,
    previousStatus: null,
    resultingStatus: null,
    previousWebsiteActive: null,
    resultingWebsiteActive: false,
    resubmissionAllowed: false,
  } as const

  it.each([
    {
      scope: "LISTING",
      event: legacyListingEvent,
      expected: LEGACY_SUPER_ADMIN_LISTING_PAUSE_MESSAGE,
    },
    {
      scope: "WEBSITE",
      event: legacyWebsiteEvent,
      expected: LEGACY_SUPER_ADMIN_WEBSITE_PAUSE_MESSAGE,
    },
  ])("corrects only the presented message for an immutable legacy $scope pause", ({
    event,
    expected,
  }) => {
    expect(projectModerationPublisherMessage(event)).toBe(expected)
  })

  it("does not rewrite a message when the legacy-import tuple is incomplete", () => {
    expect(
      projectModerationPublisherMessage({
        ...legacyListingEvent,
        id: "staff-created-event",
        actorUserId: "super-1",
        actorStaffRole: "SUPER_ADMIN",
      }),
    ).toBe(legacyListingEvent.publisherMessage)
  })

  it.each([
    {
      case: "listing event ID is not derived from its listing foreign key",
      event: {
        ...legacyListingEvent,
        id: "legacy-listing-another-listing-paused",
      },
    },
    {
      case: "listing event also has a website foreign key",
      event: {
        ...legacyListingEvent,
        websiteId: "website-1",
      },
    },
    {
      case: "listing event has no listing foreign key",
      event: {
        ...legacyListingEvent,
        listingId: null,
      },
    },
    {
      case: "website event ID is not derived from its website foreign key",
      event: {
        ...legacyWebsiteEvent,
        id: "legacy-website-another-website-inactive",
      },
    },
    {
      case: "website event also has a listing foreign key",
      event: {
        ...legacyWebsiteEvent,
        listingId: "listing-1",
      },
    },
    {
      case: "website event has no website foreign key",
      event: {
        ...legacyWebsiteEvent,
        websiteId: null,
      },
    },
  ])("fails closed when a legacy $case", ({ event }) => {
    expect(projectModerationPublisherMessage(event)).toBe(
      event.publisherMessage,
    )
  })
})
