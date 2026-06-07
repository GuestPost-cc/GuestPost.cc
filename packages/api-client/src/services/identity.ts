import { HttpClient } from "../client"

export class IdentityService {
  constructor(private client: HttpClient) {}

  me() {
    return this.client.get<{ id: string; email: string; name: string }>("/identity/me")
  }

  createOrganization(data: { name: string; slug: string }) {
    return this.client.post<{ id: string; name: string; slug: string }>("/identity/organizations", { json: data })
  }

  listOrganizations() {
    return this.client.get<Array<{ id: string; name: string; slug: string; role: string }>>("/identity/organizations")
  }

  inviteMember(orgId: string, data: { email: string; role: string }) {
    return this.client.post(`/identity/organizations/${orgId}/invite`, { json: data })
  }

  createTeam(orgId: string, data: { name: string }) {
    return this.client.post<{ id: string; name: string }>(`/identity/organizations/${orgId}/teams`, { json: data })
  }

  listTeams(orgId: string) {
    return this.client.get(`/identity/organizations/${orgId}/teams`)
  }

  updateProfile(data: { name: string }) {
    return this.client.patch("/identity/profile", { json: data })
  }

  updatePassword(data: { currentPassword: string; newPassword: string }) {
    return this.client.post("/identity/password", { json: data })
  }
}
