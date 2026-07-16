import { PATH_METADATA } from "@nestjs/common/constants"
import { AdminController } from "../admin.controller"
import { AdminService } from "../admin.service"

describe("Admin Operations staff picker", () => {
  it("uses a static route that cannot be shadowed by /users/:id", () => {
    const path = Reflect.getMetadata(
      PATH_METADATA,
      AdminController.prototype.listOpsStaff,
    )

    expect(path).toBe("staff/operations")
  })

  it("returns active Operations members in assignment order", async () => {
    const prisma = {
      staffMembership: {
        findMany: jest.fn().mockResolvedValue([
          {
            user: {
              id: "ops-1",
              name: "Ophelia Ops",
              email: "staff@guestpost.local",
            },
          },
        ]),
      },
    }
    const service = new AdminService(prisma as any, {} as any, {} as any)

    await expect(service.listOperationsStaff()).resolves.toEqual([
      {
        id: "ops-1",
        name: "Ophelia Ops",
        email: "staff@guestpost.local",
      },
    ])
    expect(prisma.staffMembership.findMany).toHaveBeenCalledWith({
      where: { role: "OPERATIONS", user: { banned: false } },
      include: {
        user: { select: { id: true, name: true, email: true } },
      },
      orderBy: { createdAt: "asc" },
    })
  })
})
