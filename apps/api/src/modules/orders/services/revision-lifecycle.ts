import { ConflictException } from "@nestjs/common"

const TERMINAL_REVISION_STATUSES = ["APPROVED", "REJECTED"] as const

/**
 * Mark the one active revision request fulfilled when replacement content is
 * submitted for customer review. The caller must already hold the parent
 * Order lock; PostgreSQL's partial unique index is the structural final guard.
 */
export async function closeActiveRevisionForResubmission(
  tx: any,
  orderId: string,
): Promise<string | null> {
  const active = await tx.revision.findMany({
    where: {
      orderId,
      status: { notIn: [...TERMINAL_REVISION_STATUSES] },
    },
    orderBy: { createdAt: "desc" },
    take: 2,
    select: { id: true },
  })
  if (active.length > 1) {
    throw new ConflictException({
      code: "REVISION_LIFECYCLE_CORRUPT",
      message:
        "Multiple active revisions require staff repair before resubmission",
    })
  }
  const revision = active[0]
  if (!revision) return null

  const closed = await tx.revision.updateMany({
    where: {
      id: revision.id,
      orderId,
      status: { notIn: [...TERMINAL_REVISION_STATUSES] },
    },
    data: { status: "APPROVED" },
  })
  if (closed.count !== 1) {
    throw new ConflictException(
      "Revision changed during content resubmission. Refresh and retry.",
    )
  }
  return revision.id
}
