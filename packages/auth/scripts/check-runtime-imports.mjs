const runtimeModules = [
  "../dist/email-templates/password-reset.js",
  "../dist/email-templates/verification.js",
]

for (const runtimeModule of runtimeModules) {
  await import(runtimeModule)
}
