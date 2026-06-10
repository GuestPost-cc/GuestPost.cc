"use client"

import { Card, CardContent } from "@guestpost/ui"
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { format } from "date-fns"
import { useState } from "react"
import { Badge } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { Skeleton } from "@guestpost/ui"
import { toast } from "sonner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"
import { AlertCircle, DollarSign, RefreshCw } from "lucide-react"

export default function FinancePage() {
  const [activeTab, setActiveTab] = useState("settlements")
  const queryClient = useQueryClient()

  const {
    data: settlementsData,
    isLoading: settlementsLoading,
    error: settlementsError,
    refetch: refetchSettlements,
  } = useQuery({
    queryKey: ["settlements"],
    queryFn: () => api.admin.listSettlements(),
  })

  const {
    data: withdrawalsData,
    isLoading: withdrawalsLoading,
    error: withdrawalsError,
    refetch: refetchWithdrawals,
  } = useQuery({
    queryKey: ["withdrawals"],
    queryFn: () => api.admin.listWithdrawals(),
  })

  const { mutate: handleApproveSettlement, isPending: approvingSettlement } = useMutation({
    mutationFn: (id: string) => api.admin.approveSettlement(id),
    onSuccess: () => {
      toast.success("Settlement approved")
      queryClient.invalidateQueries({ queryKey: ["settlements"] })
    },
    onError: () => toast.error("Failed to approve settlement"),
  })

  const { mutate: handleApproveWithdrawal, isPending: approvingWithdrawal } = useMutation({
    mutationFn: (id: string) => api.admin.approveWithdrawal(id),
    onSuccess: () => {
      toast.success("Withdrawal approved")
      queryClient.invalidateQueries({ queryKey: ["withdrawals"] })
    },
    onError: () => toast.error("Failed to approve withdrawal"),
  })

  const { mutate: handleRejectWithdrawal, isPending: rejectingWithdrawal } = useMutation({
    mutationFn: (id: string) => api.admin.rejectWithdrawal(id, "Rejected by admin"),
    onSuccess: () => {
      toast.success("Withdrawal rejected")
      queryClient.invalidateQueries({ queryKey: ["withdrawals"] })
    },
    onError: () => toast.error("Failed to reject withdrawal"),
  })

  const settlements = settlementsData?.items ?? []
  const withdrawals = withdrawalsData?.items ?? []

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-3xl font-bold tracking-tight">Finance</h1>
      </div>

      <div className="border-b">
        <button
          className={`pb-2 px-4 ${activeTab === "settlements" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground"}`}
          onClick={() => setActiveTab("settlements")}
        >
          Settlements ({settlements.length})
        </button>
        <button
          className={`pb-2 px-4 ml-4 ${activeTab === "withdrawals" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground"}`}
          onClick={() => setActiveTab("withdrawals")}
        >
          Withdrawals ({withdrawals.length})
        </button>
      </div>

      {activeTab === "settlements" && (
        <Card>
          <CardContent className="p-0">
            {settlementsLoading ? (
              <div className="p-6 space-y-3">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : settlementsError ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <AlertCircle className="h-10 w-10 text-destructive" />
                <p className="text-muted-foreground">Failed to load settlements</p>
                <Button variant="outline" size="sm" onClick={() => refetchSettlements()}>
                  <RefreshCw className="mr-2 h-3 w-3" /> Retry
                </Button>
              </div>
            ) : settlements.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <DollarSign className="h-10 w-10 text-muted-foreground" />
                <p className="text-muted-foreground">No settlements found</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>ID</TableHead>
                    <TableHead>Order</TableHead>
                    <TableHead>Publisher</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {settlements.map((settlement: any) => (
                    <TableRow key={settlement.id}>
                      <TableCell className="font-mono text-xs">{settlement.id?.slice(0, 8)}</TableCell>
                      <TableCell className="font-mono text-xs">{settlement.orderId?.slice(0, 8)}</TableCell>
                      <TableCell>{settlement.publisher?.name || settlement.publisher?.email || "—"}</TableCell>
                      <TableCell>${Number(settlement.grossAmount || settlement.amount || 0).toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge variant={
                          settlement.status === "PENDING" ? "default" :
                          settlement.status === "UNDER_REVIEW" ? "secondary" :
                          settlement.status === "APPROVED" ? "success" :
                          settlement.status === "PAID" ? "info" :
                          settlement.status === "DISPUTED" ? "warning" : "destructive"
                        }>
                          {settlement.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {settlement.createdAt ? format(new Date(settlement.createdAt), "PP") : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {settlement.status === "PENDING" && (
                          <Button size="sm" onClick={() => handleApproveSettlement(settlement.id)}>
                            Approve
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}

      {activeTab === "withdrawals" && (
        <Card>
          <CardContent className="p-0">
            {withdrawalsLoading ? (
              <div className="p-6 space-y-3">
                {[...Array(5)].map((_, i) => (
                  <Skeleton key={i} className="h-12 w-full" />
                ))}
              </div>
            ) : withdrawalsError ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <AlertCircle className="h-10 w-10 text-destructive" />
                <p className="text-muted-foreground">Failed to load withdrawals</p>
                <Button variant="outline" size="sm" onClick={() => refetchWithdrawals()}>
                  <RefreshCw className="mr-2 h-3 w-3" /> Retry
                </Button>
              </div>
            ) : withdrawals.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3">
                <DollarSign className="h-10 w-10 text-muted-foreground" />
                <p className="text-muted-foreground">No withdrawals found</p>
              </div>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Publisher</TableHead>
                    <TableHead>Amount</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Note</TableHead>
                    <TableHead>Created</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {withdrawals.map((withdrawal: any) => (
                    <TableRow key={withdrawal.id}>
                      <TableCell>{withdrawal.publisher?.name || withdrawal.publisher?.email || "—"}</TableCell>
                      <TableCell>${Number(withdrawal.amount || 0).toFixed(2)}</TableCell>
                      <TableCell>
                        <Badge variant={
                          withdrawal.status === "PENDING" ? "warning" :
                          withdrawal.status === "APPROVED" ? "info" :
                          withdrawal.status === "COMPLETED" ? "success" : "destructive"
                        }>
                          {withdrawal.status}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-muted-foreground">{withdrawal.note || "—"}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {withdrawal.createdAt ? format(new Date(withdrawal.createdAt), "PP") : "—"}
                      </TableCell>
                      <TableCell className="text-right">
                        {withdrawal.status === "PENDING" && (
                          <div className="flex justify-end gap-2">
                            <Button size="sm" onClick={() => handleApproveWithdrawal(withdrawal.id)}>
                              Approve
                            </Button>
                            <Button size="sm" variant="outline" onClick={() => handleRejectWithdrawal(withdrawal.id)}>
                              Reject
                            </Button>
                          </div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  )
}
