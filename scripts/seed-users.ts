const API = process.env.SEED_API_URL ?? "http://localhost:4000"

const USERS = [
  { email: "admin@guestpost.local",  password: process.env.SEED_ADMIN_PASSWORD ?? "Admin123!",    name: "Admin",         type: "STAFF",    role: "SUPER_ADMIN" },
  { email: "staff@guestpost.local",  password: process.env.SEED_STAFF_PASSWORD ?? "Staff123!",    name: "Ophelia Ops",   type: "STAFF",    role: "OPERATIONS" },
  { email: "publisher@guestpost.local",  password: process.env.SEED_PUBLISHER_PASSWORD ?? "Publisher123!", name: "John Publisher", type: "PUBLISHER", role: "PUBLISHER_OWNER" },
  { email: "client@guestpost.local", password: process.env.SEED_CLIENT_PASSWORD ?? "Client123!",   name: "Sarah Client",  type: "CUSTOMER", role: "OWNER" },
  { email: "member@guestpost.local", password: process.env.SEED_MEMBER_PASSWORD ?? "Member123!",   name: "Mike Member",   type: "CUSTOMER", role: "MEMBER" },
]

async function seed() {
  const headers: Record<string, string> = { "Content-Type": "application/json", Origin: "http://localhost:3003" }
  const authHeaders = (token: string) => ({ ...headers, Authorization: `Bearer ${token}` })

  // Sign up all users
  for (const u of USERS) {
    const signupRes = await fetch(`${API}/api/v1/auth/sign-up/email`, {
      method: "POST", headers,
      body: JSON.stringify({ email: u.email, password: u.password, name: u.name }),
    })
    if (signupRes.ok) {
      console.log(`Created user: ${u.email}`)
    } else {
      const text = await signupRes.text()
      if (text.includes("already exists")) {
        console.log(`User exists: ${u.email}`)
      } else {
        console.log(`Signup note (${u.email}): ${text}`)
      }
    }
  }

  // Sign in as admin to set up roles
  const adminSignin = await fetch(`${API}/api/v1/auth/sign-in/email`, {
    method: "POST", headers,
    body: JSON.stringify({ email: "admin@guestpost.local", password: "Admin123!" }),
  })
  if (!adminSignin.ok) throw new Error(`Admin signin failed: ${await adminSignin.text()}`)
  const adminData = await adminSignin.json()
  const adminToken = adminData.token

  // Grant admin SUPER_ADMIN role via self-service endpoint
  const setStaffRes = await fetch(`${API}/api/v1/identity/me/set-staff`, {
    method: "POST",
    headers: { ...headers, Authorization: `Bearer ${adminToken}` },
    body: JSON.stringify({ role: "SUPER_ADMIN" }),
  })
  if (setStaffRes.ok) {
    console.log(`  Admin staff role set to SUPER_ADMIN`)
  } else {
    const setStaffText = await setStaffRes.text()
    if (setStaffText.includes("already assigned")) {
      console.log(`  Admin staff role already set`)
    } else {
      console.log(`  Admin staff role note: ${setStaffText}`)
    }
  }

  // Get all users
  const usersRes = await fetch(`${API}/api/v1/admin/users`, {
    headers: authHeaders(adminToken),
  })
  const users = await usersRes.json()

  // Set up roles for each user
  for (const u of USERS) {
    if (u.email === "admin@guestpost.local") continue

    const target = users.find((x: any) => x.email === u.email)
    if (!target) { console.error(`  User not found: ${u.email}`); continue }

    if (u.type === "STAFF") {
      const staffRes = await fetch(`${API}/api/v1/admin/users/${target.id}/staff-role`, {
        method: "PATCH",
        headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
        body: JSON.stringify({ role: u.role }),
      })
      if (staffRes.ok) {
        console.log(`  Staff role set to ${u.role}: ${u.email}`)
      } else {
        console.error(`  Failed to set staff role: ${await staffRes.text()}`)
      }
    } else {
      const roleRes = await fetch(`${API}/api/v1/admin/users/${target.id}/role`, {
        method: "PATCH",
        headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
        body: JSON.stringify({ role: u.role }),
      })
      if (roleRes.ok) {
        console.log(`  Role set to ${u.role}: ${u.email}`)
      } else {
        console.error(`  Failed to set role: ${await roleRes.text()}`)
      }
    }
  }

  // For the CUSTOMER users, create an organization if they don't have one
  for (const u of USERS.filter(x => x.type === "CUSTOMER")) {
    const target = users.find((x: any) => x.email === u.email)
    if (!target) continue

    const custSignin = await fetch(`${API}/api/v1/auth/sign-in/email`, {
      method: "POST", headers,
      body: JSON.stringify({ email: u.email, password: u.password }),
    })
    if (!custSignin.ok) continue
    const custData = await custSignin.json()

    // Check if user already has organizations
    const orgsRes = await fetch(`${API}/api/v1/identity/organizations`, {
      headers: authHeaders(custData.token),
    })
    const orgs = await orgsRes.json()
    if (orgs.length === 0 && u.role === "OWNER") {
      const orgRes = await fetch(`${API}/api/v1/identity/organizations`, {
        method: "POST",
        headers: { ...authHeaders(custData.token), "Content-Type": "application/json" },
        body: JSON.stringify({ name: `${target.name}'s Agency`, slug: `${target.name?.toLowerCase().replace(/\s+/g, "-")}-agency` }),
      })
      if (orgRes.ok) {
        console.log(`  Organization created for: ${u.email}`)
      } else {
        console.log(`  Org creation note: ${await orgRes.text()}`)
      }
    }
  }

  // Give admin user a staff membership
  const adminTarget = users.find((x: any) => x.email === "admin@guestpost.local")
  if (adminTarget) {
    const staffRes = await fetch(`${API}/api/v1/admin/users/${adminTarget.id}/staff-role`, {
      method: "PATCH",
      headers: { ...authHeaders(adminToken), "Content-Type": "application/json" },
      body: JSON.stringify({ role: "SUPER_ADMIN" }),
    })
    if (staffRes.ok) {
      console.log(`  Admin staff role: SUPER_ADMIN`)
    } else {
      console.log(`  Admin staff role note: ${await staffRes.text()}`)
    }
  }

  if (!process.env.CI && !process.env.SEED_SKIP_WARNING) {
    console.log("\n⚠️  WARNING: These seed passwords are for development only!")
    console.log("   Set SEED_*_PASSWORD env vars or SEED_SKIP_WARNING=1 to suppress this.")
  }
  console.log("\nSeeding complete")
}

seed().catch((e) => { console.error(e); process.exit(1) })
