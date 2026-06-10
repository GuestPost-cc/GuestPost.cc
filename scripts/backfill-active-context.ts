import { prisma } from "@guestpost/database"

async function backfill() {
  const users = await prisma.user.findMany({
    where: { activeContext: null },
    include: {
      memberships: { orderBy: { createdAt: "asc" }, take: 1 },
      publisherMemberships: { orderBy: { createdAt: "asc" }, take: 1 },
    },
  })

  console.log(`Found ${users.length} users without ActiveContext`)

  let created = 0
  for (const user of users) {
    const activeOrganizationId = user.memberships[0]?.organizationId ?? null
    const activePublisherId = user.publisherMemberships[0]?.publisherId ?? null

    if (!activeOrganizationId && !activePublisherId) {
      console.log(`  Skipping user ${user.id} (${user.email}): no memberships`)
      continue
    }

    await prisma.activeContext.create({
      data: { userId: user.id, activeOrganizationId, activePublisherId },
    })
    created++
  }

  console.log(`Created ${created} ActiveContext records`)
}

backfill()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
