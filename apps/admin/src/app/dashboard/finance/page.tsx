"use client"

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@guestpost/ui"
import { useQuery } from "@tanstack/react-query"
import { api } from "../../../lib/api"
import { format } from "date-fns"
import { useState } from "react"
import { Badge } from "@guestpost/ui"
import { Button } from "@guestpost/ui"
import { toast } from "sonner"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@guestpost/ui"

export default function FinancePage() {
  const { data: userData } = useQuery({
    queryKey: ["users"],
    queryFn: () => api.admin.listUsers(),
  })

  const { data: orgData } = useQuery({
    queryKey: ["organizations"],
    queryFn: () => api.admin.listOrganizations(),
  })

  const { data: orderData } = useQuery({
    queryKey: ["orders"],
    queryFn: () => api.admin.listOrders(),
  })

  const { data: campaignData } = useQuery({
    queryKey: ["campaigns"],
    queryFn: () => api.campaigns.listCampaigns(),
  })

  const [activeTab, setActiveTab] = useState("settlements")

  // Settlements data
  const { data: settlementsData, refetch: refetchSettlements } = useQuery({
    queryKey: ["settlements"],
    queryFn: () => api.admin.listSettlements(),
  })

  // Withdrawals data
  const { data: withdrawalsData, refetch: refetchWithdrawals } = useQuery({
    queryKey: ["withdrawals"],
    queryFn: () => api.admin.listWithdrawals(),
  })

  const handleApproveSettlement = async (id: string) => {
    try {
      await api.admin.approveSettlement(id)
      toast.success("Settlement approved successfully")
      refetchSettlements()
    } catch (error) {
      toast.error("Failed to approve settlement")
    }
  }

  const handleApproveWithdrawal = async (id: string) => {
    try {
      await api.admin.approveWithdrawal(id)
      toast.success("Withdrawal approved successfully")
      refetchWithdrawals()
    } catch (error) {
      toast.error("Failed to approve withdrawal")
    }
  }

  const handleRejectWithdrawal = async (id: string, note?: string) => {
    try {
      await api.admin.rejectWithdrawal(id, note)
      toast.success("Withdrawal rejected successfully")
      refetchWithdrawals()
    } catch (error) {
      toast.error("Failed to reject withdrawal")
    }
  }

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
          Settlements
        </button>
        <button
          className={`pb-2 px-4 ml-4 ${activeTab === "withdrawals" ? "border-b-2 border-primary text-foreground" : "text-muted-foreground"}`}
          onClick={() => setActiveTab("withdrawals")}
        >
          Withdrawals
        </button>
      </div>

      {activeTab === "settlements" && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>ID</TableHead>
                <TableHead>Order ID</TableHead>
                <TableHead>Publisher</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Review Window Ends</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {settlementsData?.map((settlement: any) => (
                <TableRow key={settlement.id}>
                  <TableCell className="font-mono text-xs">{settlement.id.slice(0, 8)}</TableCell>
                  <TableCell>{settlement.orderId.slice(0, 8)}</TableCell>
                  <TableCell>{settlement.publisher.name || settlement.publisher.email}</TableCell>
                  <TableCell>{settlement.amount} {settlement.currency}</TableCell>
                  <TableCell>
                    <Badge variant={settlement.status === "PENDING" ? "default" : 
                          settlement.status === "UNDER_REVIEW" ? "secondary" : 
                          settlement.status === "APPROVED" ? "success" : 
                          settlement.status === "PAID" ? "info" : 
                          settlement.status === "DISPUTED" ? "warning" : "destructive"}>
                      {settlement.status}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {settlement.reviewWindowEndsAt 
                      ? format(new Date(settlement.reviewWindowEndsAt), "PP")
                      : "N/A"}
                  </TableCell>
                  <TableCell>{format(new Date(settlement.createdAt), "PP")}</TableCell>
                  <TableCell>
                    {settlement.status === "PENDING" && (
                      <Button 
                        size="sm" 
                        onClick={() => handleApproveSettlement(settlement.id)}
                      >
                        Approve
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {activeTab === "withdrawals" && (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Publisher</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Note</TableHead>
                <TableHead>Created</TableHead>
                <TableHead>Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {withdrawalsData?.map((withdrawal: any) => (
                <TableRow key={withdrawal.id}>
                  <TableCell>{withdrawal.publisher.name || withdrawal.publisher.email}</TableCell>
                  <TableCell>{withdrawal.amount} {withdrawal.currency}</TableCell>
                  <TableCell>
                    <Badge variant={withdrawal.status === "PENDING" ? "warning" : 
                          withdrawal.status === "APPROVED" ? "info" : 
                          withdrawal.status === "COMPLETED" ? "success" : "destructive"}>
                      {withdrawal.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{withdrawal.note}</TableCell>
                  <TableCell>{format(new Date(withdrawal.createdAt), "PP")}</TableCell>
                  <TableCell>
                    {withdrawal.status === "PENDING" && (
                      <div className="flex gap-2">
                        <Button 
                          size="sm" 
                          onClick={() => handleApproveWithdrawal(withdrawal.id)}
                        >
                          Approve
                        </Button>
                        <Button 
                          size="sm" 
                          variant="outline"
                          onClick={() => handleRejectWithdrawal(withdrawal.id, "Rejected by admin")}
                        >
                          Reject
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}