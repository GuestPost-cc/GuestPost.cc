import {
  buildModerationProjection,
  getPublisherListingLifecycleActions,
  getPublisherWebsiteLifecycleActions,
  getStaffListingModerationActions,
  getStaffWebsiteModerationActions,
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
})
