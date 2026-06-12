import { HttpClient } from "../client"

export type OrganizationMember = {
  id: string
  userId: string
  name: string | null
  email: string
  image: string | null
  role: "OWNER" | "MEMBER"
  banned: boolean
  joinedAt: string
}

export type OrganizationDetail = {
  id: string
  name: string
  slug: string
  plan: string
  createdAt: string
  memberCount: number
  teamCount: number
  myRole: "OWNER" | "MEMBER"
}

export type Team = {
  id: string
  name: string
  organizationId: string
  createdAt: string
}

export class IdentityService {
  constructor(private client: HttpClient) {}

  me() {
    return this.client.get<{ id: string; email: string; name: string }>("/identity/me")
  }

  createOrganization(data: { name: string; slug: string }) {
    return this.client.post<{ id: string; name: string; slug: string }>("/identity/organizations", { json: data })
  }

  // Self-serve publisher onboarding — fresh accounts only (backend enforces)
  becomePublisher(publisherName?: string) {
    return this.client.post<{ id: string; name: string; tier: string }>("/identity/become-publisher", {
      json: publisherName ? { publisherName } : {},
    })
  }

  listOrganizations() {
    return this.client.get<Array<{ id: string; name: string; slug: string; role: string; isActive: boolean }>>("/identity/organizations")
  }

  switchOrganization(organizationId: string) {
    return this.client.post<{ activeOrganizationId: string }>("/identity/switch-organization", {
      json: { organizationId },
    })
  }

  // Pending org invitations awaiting this user's response
  listInvites() {
    return this.client.get<Array<{
      membershipId: string
      organizationId: string
      organizationName: string
      role: string
      invitedAt: string
    }>>("/identity/invites")
  }

  acceptInvite(membershipId: string) {
    return this.client.post<{ accepted: boolean; organizationId: string; role: string }>(
      `/identity/invites/${membershipId}/accept`,
    )
  }

  declineInvite(membershipId: string) {
    return this.client.post<{ accepted: boolean }>(`/identity/invites/${membershipId}/decline`)
  }

  getOrganization(orgId: string) {
    return this.client.get<OrganizationDetail>(`/identity/organizations/${orgId}`)
  }

  inviteMember(orgId: string, data: { email: string; role: string }) {
    return this.client.post(`/identity/organizations/${orgId}/invite`, { json: data })
  }

  removeMember(orgId: string, userId: string) {
    return this.client.delete(`/identity/organizations/${orgId}/members/${userId}`)
  }

  listMembers(orgId: string) {
    return this.client.get<OrganizationMember[]>(`/identity/organizations/${orgId}/members`)
  }

  createTeam(orgId: string, data: { name: string }) {
    return this.client.post<{ id: string; name: string }>(`/identity/organizations/${orgId}/teams`, { json: data })
  }

  deleteTeam(orgId: string, teamId: string) {
    return this.client.delete(`/identity/organizations/${orgId}/teams/${teamId}`)
  }

  listTeams(orgId: string) {
    return this.client.get<Team[]>(`/identity/organizations/${orgId}/teams`)
  }

  updateProfile(data: { name: string }) {
    return this.client.patch("/identity/profile", { json: data })
  }

  updatePassword(data: { currentPassword: string; newPassword: string }) {
    return this.client.post("/identity/password", { json: data })
  }
}
