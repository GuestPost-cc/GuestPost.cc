import { ForbiddenException } from "@nestjs/common"

/**
 * Revalidate current staff authority inside the same transaction and after the
 * same Order lock as a sensitive delivery decision. Token roles are cached
 * context only; they are never sufficient authorization for money-adjacent
 * state changes.
 */
export async function assertCurrentStaffAuthority(
  tx: any,
  userId: string,
  claimedRole: string,
  allowedRoles: readonly string[],
): Promise<string> {
  const staff = await tx.staffMembership.findUnique({
    where: { userId },
    include: { user: { select: { userType: true, banned: true } } },
  })
  if (
    !staff ||
    staff.role !== claimedRole ||
    !allowedRoles.includes(staff.role) ||
    staff.user?.userType !== "STAFF" ||
    staff.user?.banned
  ) {
    throw new ForbiddenException(
      "Current staff authority does not permit this delivery decision",
    )
  }
  return staff.role
}
