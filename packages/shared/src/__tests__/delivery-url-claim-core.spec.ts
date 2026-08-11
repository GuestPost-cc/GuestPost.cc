import {
  buildDeliveryUrlReuseCandidate,
  lockDeliveryUrlClaim,
  refreshDeliveryUrlReuseEvidenceUnderLock,
} from "../delivery-url-claim-core"

const normalizedUrl = "https://publisher.example/article"

function authorizedLegacyFlag() {
  return {
    id: "flag-authorized",
    details: {
      otherOrderId: "order-other-1",
      otherVersionId: "delivery-other-1",
      reuseCount: 1,
    },
    resolution: {
      kind: "STAFF_CLEARED",
      resolvedByUserId: "finance-user",
      resolvedByRole: "FINANCE",
      evidence: {
        adjudicatedDeliveryVersionId: "delivery-current",
        fraudType: "URL_REUSED",
        disposition: "AUTHORIZED_REUSE",
        evidenceReference: "CASE-1001",
        roleAtTime: "FINANCE",
      },
    },
  }
}

describe("delivery URL claim freshness", () => {
  it("binds the URL as a parameter to the database advisory-and-row fence", async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ acquire_delivery_url_claim_fence: null }])

    await lockDeliveryUrlClaim(
      { $queryRaw: query },
      "https://example.test/'unsafe",
    )

    const [strings, url, namespace] = query.mock.calls[0]
    expect(strings.join("?")).toContain(
      'SELECT "acquire_delivery_url_claim_fence"(?)',
    )
    expect(url).toBe("https://example.test/'unsafe")
    expect(namespace).toBeUndefined()
  })

  it("reuses an exact legacy staff authorization without weakening changed evidence", async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      orderDeliveryVersion: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "delivery-other-1", orderId: "order-other-1" },
          ]),
        count: jest.fn().mockResolvedValue(1),
      },
      deliveryFraudFlag: {
        findMany: jest.fn().mockResolvedValue([authorizedLegacyFlag()]),
        create: jest.fn(),
      },
      auditLog: { create: jest.fn() },
    }

    const result = await refreshDeliveryUrlReuseEvidenceUnderLock(tx, {
      orderId: "order-current",
      deliveryVersionId: "delivery-current",
      normalizedUrl,
      organizationId: "organization-current",
      source: "CUSTOMER_MANUAL_ACCEPT",
    })

    expect(result.requiresReview).toBe(false)
    expect(result.createdFlagId).toBeNull()
    expect(tx.deliveryFraudFlag.create).not.toHaveBeenCalled()
  })

  it("serializes a concurrent claim writer ahead of acceptance and flags the changed claim set", async () => {
    const state = {
      claims: [{ id: "delivery-other-1", orderId: "order-other-1" }],
      flags: [authorizedLegacyFlag()] as any[],
    }
    const events: string[] = []
    let lockTail = Promise.resolve()

    async function runTransaction<T>(
      name: string,
      operation: (tx: any) => Promise<T>,
    ): Promise<T> {
      let release: () => void = () => {}
      const tx = {
        $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
          if (!strings.join(" ").includes("acquire_delivery_url_claim_fence")) {
            return [{ id: "communication-url-reuse" }]
          }
          events.push(`${name}:waiting`)
          const prior = lockTail
          lockTail = new Promise<void>((resolve) => {
            release = resolve
          })
          await prior
          events.push(`${name}:locked`)
          return []
        }),
        orderDeliveryVersion: {
          findMany: jest.fn(async ({ take }: any) =>
            [...state.claims]
              .sort((left, right) => left.id.localeCompare(right.id))
              .slice(0, take),
          ),
          count: jest.fn(async () => state.claims.length),
        },
        deliveryFraudFlag: {
          findMany: jest.fn(async () => [...state.flags]),
          create: jest.fn(async ({ data }: any) => {
            const flag = { id: "flag-fresh", ...data, resolution: null }
            state.flags.push(flag)
            return flag
          }),
        },
        auditLog: { create: jest.fn().mockResolvedValue({}) },
        staffMembership: {
          findMany: jest.fn().mockResolvedValue([{ userId: "staff-user" }]),
        },
        user: {
          findMany: jest.fn().mockResolvedValue([
            {
              id: "staff-user",
              email: "staff@example.test",
              emailVerified: true,
              banned: false,
              notificationPreferences: [],
              emailSuppressions: [],
            },
          ]),
        },
        notification: { upsert: jest.fn().mockResolvedValue({}) },
        communicationEvent: {
          upsert: jest.fn().mockImplementation(({ create }: any) =>
            Promise.resolve({
              id: "communication-url-reuse",
              ...create,
              payload: create.payload ?? null,
            }),
          ),
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        communicationDelivery: {
          count: jest.fn().mockResolvedValue(1),
          upsert: jest.fn().mockResolvedValue({
            id: "communication-delivery-url-reuse",
            status: "PENDING",
          }),
        },
      }
      try {
        return await operation(tx)
      } finally {
        release()
      }
    }

    let writerHasLock: () => void = () => {}
    const writerLocked = new Promise<void>((resolve) => {
      writerHasLock = resolve
    })
    let letWriterCommit: () => void = () => {}
    const writerCommitGate = new Promise<void>((resolve) => {
      letWriterCommit = resolve
    })
    const writer = runTransaction("writer", async (tx) => {
      await lockDeliveryUrlClaim(tx, normalizedUrl)
      writerHasLock()
      await writerCommitGate
      state.claims.push({
        id: "delivery-other-2",
        orderId: "order-other-2",
      })
      events.push("writer:claim-written")
    })
    await writerLocked

    const acceptance = runTransaction("acceptance", (tx) =>
      refreshDeliveryUrlReuseEvidenceUnderLock(tx, {
        orderId: "order-current",
        deliveryVersionId: "delivery-current",
        normalizedUrl,
        organizationId: "organization-current",
        actorUserId: "customer-user",
        source: "CUSTOMER_MANUAL_ACCEPT",
      }),
    )
    await Promise.resolve()
    expect(events).toEqual([
      "writer:waiting",
      "writer:locked",
      "acceptance:waiting",
    ])

    letWriterCommit()
    const [, result] = await Promise.all([writer, acceptance])

    expect(events).toEqual([
      "writer:waiting",
      "writer:locked",
      "acceptance:waiting",
      "writer:claim-written",
      "acceptance:locked",
    ])
    expect(result.requiresReview).toBe(true)
    expect(result.createdFlagId).toBe("flag-fresh")
    expect(result.communicationEventId).toBe("communication-url-reuse")
    expect(result.communicationDedupKey).toContain(
      result.candidate!.details.claimFingerprint,
    )
    expect(result.communicationDedupKey).not.toContain("flag-fresh")
    expect(result.candidate?.details).toEqual(
      expect.objectContaining({
        reuseCount: 2,
        claimFingerprintVersion: 1,
        claimFingerprint: expect.any(String),
      }),
    )
    expect(state.flags).toHaveLength(2)
  })

  it("makes the claim fingerprint change whenever the append-only claim count changes", async () => {
    const db = {
      orderDeliveryVersion: {
        findMany: jest
          .fn()
          .mockResolvedValue([
            { id: "delivery-other-1", orderId: "order-other-1" },
          ]),
        count: jest.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(2),
      },
    }

    const first = await buildDeliveryUrlReuseCandidate(db, {
      orderId: "order-current",
      normalizedUrl,
    })
    const second = await buildDeliveryUrlReuseCandidate(db, {
      orderId: "order-current",
      normalizedUrl,
    })

    expect(first?.details.claimFingerprint).not.toBe(
      second?.details.claimFingerprint,
    )
  })
})
