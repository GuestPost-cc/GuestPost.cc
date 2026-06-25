const API = process.env.SEED_API_URL || "http://localhost:4000"
const EMAIL = process.env.SEED_ADMIN_EMAIL || "admin@guestpost.local"
const PASSWORD = process.env.SEED_ADMIN_PASSWORD || "Admin123!"

async function seed() {
  const headers = {
    "Content-Type": "application/json",
    Origin: "http://localhost:3000",
  }

  // Sign up admin user (may fail if already exists)
  const signupRes = await fetch(`${API}/api/v1/auth/sign-up/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD, name: "Admin" }),
  })
  let userId: string | null = null
  if (signupRes.ok) {
    const data = await signupRes.json()
    userId = data.user?.id ?? null
    console.log(`Created user: ${userId}`)
  } else {
    const text = await signupRes.text()
    console.log(`Signup skipped (${signupRes.status}): ${text}`)
  }

  // Sign in
  const signinRes = await fetch(`${API}/api/v1/auth/sign-in/email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email: EMAIL, password: PASSWORD }),
  })
  if (!signinRes.ok) throw new Error(`Signin failed: ${await signinRes.text()}`)
  const signinData = await signinRes.json()
  userId = userId ?? signinData.user?.id
  console.log(`Signed in: ${signinData.user?.name ?? "?"}`)

  // Set user type to STAFF
  if (userId) {
    const updateRes = await fetch(`${API}/api/v1/identity/me/set-staff`, {
      method: "POST",
      headers: {
        ...headers,
        Cookie: signinRes.headers.get("set-cookie") ?? "",
      },
      body: JSON.stringify({ role: "SUPER_ADMIN" }),
    })
    if (updateRes.ok) {
      console.log(`Staff membership created: SUPER_ADMIN`)
    } else {
      console.log(`Staff membership note: ${await updateRes.text()}`)
    }
  }

  // Get my profile
  const meRes = await fetch(`${API}/api/v1/identity/me`, {
    headers: { ...headers, Cookie: signinRes.headers.get("set-cookie") ?? "" },
  })
  const me = await meRes.json()
  console.log(
    `Me: ${me.name} (userType: ${me.userType}, staffRole: ${me.staffRole ?? "?"})`,
  )
}

seed().catch((e) => {
  console.error(e)
  process.exit(1)
})
