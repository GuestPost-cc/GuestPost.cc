"use client"

import {
  Badge,
  Button,
  Card,
  CardContent,
  Input,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import {
  type ColumnDef,
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getPaginationRowModel,
  useReactTable,
} from "@tanstack/react-table"
import { format } from "date-fns"
import { AlertCircle, Building, Calendar, Search, Users } from "lucide-react"
import { useMemo, useState } from "react"
import { api } from "../../../lib/api"
import { ForbiddenPage, useRequireRole } from "../../../lib/use-require-role"

interface Organization {
  id: string
  name: string
  slug: string
  plan: string | null
  createdAt: string
  _count: {
    memberships: number
    campaigns: number
    orders: number
  }
}

const columnHelper = createColumnHelper<Organization>()

export default function OrganizationsPage() {
  const { allowed, loading } = useRequireRole("SUPER_ADMIN")
  if (loading) return null
  if (!allowed) return <ForbiddenPage requires="Super Admin" />
  return <OrganizationsPageInner />
}

function OrganizationsPageInner() {
  const [search, setSearch] = useState("")
  const [planFilter, setPlanFilter] = useState<string>("all")

  const {
    data: orgs = [],
    isLoading,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin", "organizations"],
    queryFn: () => api.admin.listOrganizations(),
    retry: 1,
  })

  const columns = useMemo<ColumnDef<Organization, any>[]>(
    () => [
      columnHelper.accessor("name", {
        header: "Name",
        cell: (info) => (
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Building className="h-4 w-4 text-primary" />
            </div>
            <div>
              <div className="font-medium">{info.getValue()}</div>
              <div className="text-xs text-muted-foreground">
                /{info.row.original.slug}
              </div>
            </div>
          </div>
        ),
      }),
      columnHelper.accessor("plan", {
        header: "Plan",
        cell: (info) => {
          const plan = info.getValue()
          return (
            <Badge
              variant={
                plan === "ENTERPRISE"
                  ? "default"
                  : plan === "PRO"
                    ? "secondary"
                    : "outline"
              }
              className="capitalize"
            >
              {plan?.toLowerCase() ?? "free"}
            </Badge>
          )
        },
      }),
      columnHelper.accessor((row) => row._count.memberships, {
        id: "members",
        header: "Members",
        cell: (info) => (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Users className="h-3 w-3" />
            {info.getValue()}
          </span>
        ),
      }),
      columnHelper.accessor((row) => row._count.campaigns, {
        id: "campaigns",
        header: "Campaigns",
        cell: (info) => (
          <span className="text-muted-foreground">{info.getValue()}</span>
        ),
      }),
      columnHelper.accessor((row) => row._count.orders, {
        id: "orders",
        header: "Orders",
        cell: (info) => (
          <span className="text-muted-foreground">{info.getValue()}</span>
        ),
      }),
      columnHelper.accessor("createdAt", {
        header: "Created",
        cell: (info) => (
          <span className="inline-flex items-center gap-1 text-muted-foreground">
            <Calendar className="h-3 w-3" />
            {format(new Date(info.getValue()), "PP")}
          </span>
        ),
      }),
    ],
    [],
  )

  const filteredOrgs = useMemo(() => {
    return orgs.filter((o) => {
      const matchesSearch =
        search === "" ||
        o.name.toLowerCase().includes(search.toLowerCase()) ||
        o.slug.toLowerCase().includes(search.toLowerCase())
      const matchesPlan = planFilter === "all" || o.plan === planFilter
      return matchesSearch && matchesPlan
    })
  }, [orgs, search, planFilter])

  const table = useReactTable({
    data: filteredOrgs,
    columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    state: { pagination: { pageIndex: 0, pageSize: 20 } },
  })

  if (error) {
    return (
      <div className="flex min-h-[400px] flex-col items-center justify-center gap-4">
        <AlertCircle className="h-12 w-12 text-destructive" />
        <p className="text-destructive">{error.message}</p>
        <Button onClick={() => refetch()}>Retry</Button>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">Organizations</h1>
        <p className="text-muted-foreground">
          Global customer organization directory
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search by name or slug..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <Select value={planFilter} onValueChange={setPlanFilter}>
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="Plan" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Plans</SelectItem>
            <SelectItem value="FREE">Free</SelectItem>
            <SelectItem value="STARTER">Starter</SelectItem>
            <SelectItem value="PRO">Pro</SelectItem>
            <SelectItem value="ENTERPRISE">Enterprise</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <Card>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-6 space-y-3">
              {[...Array(5)].map((_, i) => (
                <Skeleton key={i} className="h-14 w-full" />
              ))}
            </div>
          ) : filteredOrgs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <Building className="h-10 w-10 text-muted-foreground" />
              <p className="text-muted-foreground">No organizations found</p>
            </div>
          ) : (
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((hg) => (
                  <TableRow key={hg.id}>
                    {hg.headers.map((h) => (
                      <TableHead key={h.id}>
                        {h.isPlaceholder
                          ? null
                          : flexRender(
                              h.column.columnDef.header,
                              h.getContext(),
                            )}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id}>
                        {typeof cell.column.columnDef.cell === "function"
                          ? cell.column.columnDef.cell(cell.getContext())
                          : null}
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {filteredOrgs.length > 20 && (
        <div className="flex items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.previousPage()}
            disabled={!table.getCanPreviousPage()}
          >
            Previous
          </Button>
          <span className="text-sm text-muted-foreground">
            Page {table.getState().pagination.pageIndex + 1} of{" "}
            {table.getPageCount()}
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => table.nextPage()}
            disabled={!table.getCanNextPage()}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  )
}
